import hashlib,json,mimetypes,os,re,shutil,subprocess,tempfile
from pathlib import Path
import boto3
from sys import path
path.insert(0,"/app")
from common.server import serve

OUTPUT=Path(os.getenv("OUTPUT_DIR","/artifacts/documents"));OUTPUT.mkdir(parents=True,exist_ok=True)
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
def run_marker(source,target,output_format):
    command=["marker_single",str(source),"--output_dir",str(target),"--output_format",output_format]
    result=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=int(os.getenv("MARKER_TIMEOUT","3600")))
    if result.returncode:
        detail=SECRET.sub("[REDACTED]",result.stdout or "")[-12000:].strip()
        raise RuntimeError(f"marker_single {output_format} exited {result.returncode}: {detail or 'no diagnostic output'}")

def walk_blocks(value,page=None,section=None):
    """Flatten Marker's JSON without depending on one upstream block layout."""
    if isinstance(value,list):
        current=section
        for item in value:
            values=list(walk_blocks(item,page,current))
            yield from values
            if values and values[0]["type"].casefold() in {"sectionheader","heading","title"} and values[0]["text"]:current=values[0]["text"]
        return
    if not isinstance(value,dict):return
    kind=str(value.get("block_type") or value.get("type") or value.get("blockType") or "unknown")
    page_value=value.get("page_id",value.get("page",value.get("pageNumber",page)))
    text=str(value.get("text") or value.get("html") or value.get("content") or "").strip()
    next_section=text if kind.casefold() in {"sectionheader","heading","title"} and text else section
    image=value.get("image") or value.get("image_path") or value.get("imagePath")
    yield {"type":kind,"page":page_value,"text":text,"section":section,"image":image}
    for key_name in ("children","blocks","pages"):
        if key_name in value:yield from walk_blocks(value[key_name],page_value,next_section)

def authored_image_evidence(structured_root,target):
    blocks=[]
    for item in sorted(structured_root.rglob("*.json")):
        try:blocks.extend(walk_blocks(json.loads(item.read_text(errors="replace"))))
        except json.JSONDecodeError:continue
    image_files={item.name:item for item in target.rglob("*") if item.is_file() and (mimetypes.guess_type(item.name)[0] or "").startswith("image/")}
    evidence=[]
    for index,block in enumerate(blocks):
        reference=Path(str(block.get("image") or "")).name
        image=image_files.get(reference)
        if not image and block["type"].casefold() not in {"figure","picture","image"}:continue
        if not image and len(image_files)==1:image=next(iter(image_files.values()))
        if not image:continue
        nearby=[candidate["text"] for candidate in blocks[max(0,index-2):index+3] if candidate.get("text")]
        authored="\n".join(dict.fromkeys(nearby)).strip()
        eligible=bool(authored and (block.get("section") or len(authored)>=24))
        evidence.append({"imagePath":str(image.relative_to(target)),"imageSha256":hashlib.sha256(image.read_bytes()).hexdigest(),"mimeType":mimetypes.guess_type(image.name)[0] or "application/octet-stream","page":block.get("page"),"section":block.get("section"),"authoredContext":authored,"eligible":eligible})
    return blocks,evidence
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
        markdown_target=target/"markdown";structured_target=target/"structured"
        run_marker(source,markdown_target,"markdown")
        run_marker(source,structured_target,"json")
        for image in markdown_target.rglob("*"):
            if image.is_file() and (mimetypes.guess_type(image.name)[0] or "").startswith("image/"):
                destination=target/"images"/image.name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(image,destination)
    markdown_files=sorted(target.rglob("*.md"));text="\n".join(item.read_text(errors="replace") for item in markdown_files)
    if not text.strip():return{"state":"quarantined","diagnostics":{"code":"empty_document"}}
    if SECRET.search(text):return{"state":"quarantined","diagnostics":{"code":"suspected_secret"}}
    objects=[]
    for item in sorted(target.rglob("*")):
        if item.is_file():objects.append({"path":str(item.relative_to(target)),"size":item.stat().st_size,"sha256":hashlib.sha256(item.read_bytes()).hexdigest()})
    blocks,image_evidence=authored_image_evidence(target/"structured",target)
    manifest={"schemaVersion":"ai.document-bundle/v3","source":{"filename":filename,"sha256":value["sha256"],"declaredMimeType":value.get("declaredMimeType"),"detectedMimeType":value.get("detectedMimeType")},"objects":objects,"structured":{"blockCount":len(blocks),"pages":sorted({item["page"] for item in blocks if item.get("page") is not None},key=str)},"images":image_evidence,"relationships":value.get("relationship",{}),"provenance":{"processor":"marker","mode":"balanced","outputs":["markdown","json"]}}
    (target/"manifest.json").write_text(json.dumps(manifest,sort_keys=True,separators=(",",":")))
    return{"state":"ready","resultManifest":upload_bundle(target,job["jobId"]),"tokenCount":max(1,len(text)//4)}
serve({"/process":process})
