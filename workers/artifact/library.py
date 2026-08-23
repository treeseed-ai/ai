import hashlib, json, os, re, unicodedata, zipfile
from pathlib import Path
import boto3

TEXT_EXTENSIONS={".md":"text/markdown",".txt":"text/plain",".json":"application/json",".jsonl":"application/x-ndjson",".xml":"application/xml",".yaml":"application/yaml",".yml":"application/yaml",".toml":"application/toml",".ini":"text/plain",".sql":"application/sql",".py":"text/x-python",".js":"text/javascript",".ts":"text/typescript",".tsx":"text/typescript",".jsx":"text/javascript",".java":"text/x-java",".go":"text/x-go",".rs":"text/x-rust",".c":"text/x-c",".h":"text/x-c",".cpp":"text/x-c++",".hpp":"text/x-c++",".cs":"text/x-csharp",".rb":"text/x-ruby",".php":"text/x-php",".sh":"application/x-sh"}
MARKER_TYPES={"application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.presentationml.presentation","text/html"}
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
def client(): return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix): raise ValueError("Library object is outside the training bucket")
    return str(uri)[len(prefix):]
def bytes_for(uri): return client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(uri))["Body"].read()
def upload_bytes(value,name,mime):
    digest=hashlib.sha256(value).hexdigest();object_key=f"normalized/{digest}/{name}";client().put_object(Bucket=os.environ["S3_BUCKET"],Key=object_key,Body=value,ContentType=mime,Metadata={"sha256":digest});return{"uri":f"s3://{os.environ['S3_BUCKET']}/{object_key}","size":len(value),"sha256":digest}
def detect(data,filename):
    extension=Path(filename).suffix.lower()
    if data.startswith(b"%PDF-"): return "application/pdf","marker"
    if data.startswith(b"PK\x03\x04"):
        try:
            from io import BytesIO
            with zipfile.ZipFile(BytesIO(data)) as value:
                names=set(value.namelist());expanded=sum(item.file_size for item in value.infolist())
                if expanded>500*1024*1024 or expanded>max(len(data)*100,10_000_000): raise ValueError("Office container expansion is unsafe")
                if "word/document.xml" in names:return "application/vnd.openxmlformats-officedocument.wordprocessingml.document","marker"
                if "ppt/presentation.xml" in names:return "application/vnd.openxmlformats-officedocument.presentationml.presentation","marker"
                if "xl/workbook.xml" in names:raise ValueError("Spreadsheets are not supported")
        except zipfile.BadZipFile: raise ValueError("Malformed document container")
        raise ValueError("Archives and unsupported document containers are rejected")
    if b"\0" in data[:8192]: raise ValueError("Binary document type is unsupported")
    try:text=data.decode("utf-8")
    except UnicodeDecodeError:raise ValueError("Text documents must be UTF-8")
    if extension in {".html",".htm"} and re.search(r"(?is)<(?:!doctype\s+html|html|head|body)\b",text):return "text/html","marker"
    if extension not in TEXT_EXTENSIONS:raise ValueError("Unsupported document type")
    return TEXT_EXTENSIONS[extension],"direct"
def classify(job):
    value=job["input"];data=bytes_for(value["objectUri"]);actual=hashlib.sha256(data).hexdigest()
    if actual!=value["sha256"]:raise ValueError("Source object checksum does not match")
    try:mime,processor=detect(data,value["filename"])
    except ValueError as error:return{"state":"quarantined","processor":"classifier","detectedMimeType":"application/octet-stream","diagnostics":{"code":"unsupported_or_unsafe","message":str(error)}}
    if processor=="marker":return{"state":"pending_processing","processor":"marker","detectedMimeType":mime,"objectUri":value["objectUri"]}
    text=unicodedata.normalize("NFC",data.decode("utf-8")).replace("\r\n","\n").replace("\r","\n")
    if SECRET.search(text):return{"state":"quarantined","processor":"direct","detectedMimeType":mime,"diagnostics":{"code":"suspected_secret"}}
    if not text.strip():return{"state":"quarantined","processor":"direct","detectedMimeType":mime,"diagnostics":{"code":"empty_document"}}
    normalized=upload_bytes((text.rstrip()+"\n").encode(),"document.md","text/markdown" if mime=="text/markdown" else "text/plain")
    manifest={"schemaVersion":"ai.document-bundle/v2","source":{"sha256":actual,"filename":value["filename"],"declaredMimeType":value.get("declaredMimeType"),"detectedMimeType":mime},"objects":[normalized],"relationships":value.get("relationship",{}),"provenance":{"processor":"treeai-direct","version":"1"}}
    encoded=json.dumps(manifest,sort_keys=True,separators=(",",":")).encode();stored=upload_bytes(encoded,"manifest.json","application/json")
    return{"state":"ready","processor":"direct","detectedMimeType":mime,"resultManifest":stored["uri"],"tokenCount":max(1,len(text)//4)}
