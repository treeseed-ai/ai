import hashlib,json,os,re,subprocess,tempfile
from pathlib import Path
import boto3
from sys import path
path.insert(0,"/app")
from common.server import serve

OUTPUT=Path(os.getenv("OUTPUT_DIR","/artifacts/documents"));OUTPUT.mkdir(parents=True,exist_ok=True)
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
def client():return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def object_key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix):raise ValueError("Document is outside the training bucket")
    return str(uri)[len(prefix):]
def upload_bundle(target,job_id):
    s3=client();bucket=os.environ["S3_BUCKET"]
    for item in target.rglob("*"):
        if item.is_file():s3.upload_file(str(item),bucket,f"documents/{job_id}/{item.relative_to(target)}")
    return f"s3://{bucket}/documents/{job_id}/manifest.json"
def process(job):
    value=job["input"];uri=value.get("objectUri");filename=Path(str(value.get("filename","document"))).name
    if not uri or filename!=value.get("filename"):raise ValueError("A safe document identity and object URI are required")
    data=client().get_object(Bucket=os.environ["S3_BUCKET"],Key=object_key(uri))["Body"].read()
    if hashlib.sha256(data).hexdigest()!=value.get("sha256"):raise ValueError("Source object checksum does not match")
    target=OUTPUT/job["jobId"];target.mkdir(exist_ok=True)
    if (target/"manifest.json").exists():
        existing="\n".join(item.read_text(errors="replace") for item in sorted(target.rglob("*.md")))
        return{"state":"ready","resultManifest":upload_bundle(target,job["jobId"]),"tokenCount":max(1,len(existing)//4)}
    with tempfile.TemporaryDirectory(prefix="treeai-marker-") as temporary:
        source=Path(temporary)/filename;source.write_bytes(data)
        subprocess.run(["marker_single",str(source),"--output_dir",str(target),"--output_format","markdown","--mode","balanced"],check=True,timeout=int(os.getenv("MARKER_TIMEOUT","3600")))
    markdown_files=sorted(target.rglob("*.md"));text="\n".join(item.read_text(errors="replace") for item in markdown_files)
    if not text.strip():return{"state":"quarantined","diagnostics":{"code":"empty_document"}}
    if SECRET.search(text):return{"state":"quarantined","diagnostics":{"code":"suspected_secret"}}
    objects=[]
    for item in sorted(target.rglob("*")):
        if item.is_file():objects.append({"path":str(item.relative_to(target)),"size":item.stat().st_size,"sha256":hashlib.sha256(item.read_bytes()).hexdigest()})
    manifest={"schemaVersion":"ai.document-bundle/v2","source":{"filename":filename,"sha256":value["sha256"],"declaredMimeType":value.get("declaredMimeType"),"detectedMimeType":value.get("detectedMimeType")},"objects":objects,"relationships":value.get("relationship",{}),"provenance":{"processor":"marker","mode":"balanced"}}
    (target/"manifest.json").write_text(json.dumps(manifest,sort_keys=True,separators=(",",":")))
    return{"state":"ready","resultManifest":upload_bundle(target,job["jobId"]),"tokenCount":max(1,len(text)//4)}
serve({"/process":process})
