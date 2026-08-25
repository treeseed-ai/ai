import hashlib,json,mimetypes,os,re,shutil,tempfile,threading
from pathlib import Path
import boto3
from sys import path
from urllib.parse import unquote
path.insert(0,"/app")
from common.server import serve

OUTPUT=Path(os.getenv("OUTPUT_DIR","/artifacts/documents"));OUTPUT.mkdir(parents=True,exist_ok=True)
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
STATUS={};STATUS_LOCK=threading.Lock();_CONVERTER=None;_CONVERTER_LOCK=threading.Lock()
def supported_image(path):
    head=path.read_bytes()[:16]
    return head.startswith(b"\x89PNG\r\n\x1a\n") or head.startswith(b"\xff\xd8\xff") or (head.startswith(b"RIFF") and head[8:12]==b"WEBP")
def set_status(job_id,phase,progress):
    with STATUS_LOCK:
        STATUS.pop(job_id,None);STATUS[job_id]={"phase":phase,"progress":progress}
        if len(STATUS)>256:STATUS.pop(next(iter(STATUS)))
def status(job):
    with STATUS_LOCK:return STATUS.get(str(job.get("jobId","")),{"phase":"queued","progress":0.05})
def marker_converter():
    global _CONVERTER
    with _CONVERTER_LOCK:
        if _CONVERTER is None:
            from marker.config.parser import ConfigParser
            from marker.models import create_model_dict
            parser=ConfigParser({"output_format":"markdown","mode":"balanced"})
            converter_cls=parser.get_converter_cls()
            _CONVERTER=converter_cls(config=parser.generate_config_dict(),artifact_dict=create_model_dict(),processor_list=parser.get_processors(),renderer=parser.get_renderer(),llm_service=parser.get_llm_service())
    return _CONVERTER
def convert_document(source,markdown_target,structured_target,job_id):
    from marker.output import save_output
    from marker.renderers.json import JSONRenderer
    from marker.renderers.markdown import MarkdownRenderer
    set_status(job_id,"loading",.10);converter=marker_converter()
    set_status(job_id,"processing",.20);document=converter.build_document(str(source))
    base=source.stem;markdown_target.mkdir(parents=True,exist_ok=True);structured_target.mkdir(parents=True,exist_ok=True)
    set_status(job_id,"rendering_markdown",.78);save_output(converter.resolve_dependencies(MarkdownRenderer)(document),str(markdown_target),base)
    set_status(job_id,"rendering_structured",.86);save_output(converter.resolve_dependencies(JSONRenderer)(document),str(structured_target),base)
    set_status(job_id,"rendered",.90)
def safe_error(error):return SECRET.sub("[REDACTED]",str(error))[-12000:].strip() or "no diagnostic output"

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
        eligible=bool(supported_image(image) and authored and (block.get("section") or len(authored)>=24))
        evidence.append({"imagePath":str(image.relative_to(target)),"imageSha256":hashlib.sha256(image.read_bytes()).hexdigest(),"mimeType":mimetypes.guess_type(image.name)[0] or "application/octet-stream","page":block.get("page"),"section":block.get("section"),"authoredContext":authored,"eligible":eligible})
    markdown_root=target/"markdown"
    image_files={item.name:item for item in (target/"images").rglob("*") if item.is_file()}
    image_pattern=re.compile(r'!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<img\b[^>]*\bsrc=["\']([^"\']+)["\'][^>]*>',re.I)
    for document in sorted(markdown_root.rglob("*.md")) if markdown_root.exists() else []:
        lines=document.read_text(errors="replace").splitlines();heading=None
        for index,line in enumerate(lines):
            heading_match=re.match(r"^#{1,6}\s+(.+)$",line.strip())
            if heading_match:heading=heading_match.group(1).strip()
            for match in image_pattern.finditer(line):
                reference=Path(unquote(match.group(2) or match.group(3) or "")).name;image=image_files.get(reference)
                if not image:continue
                nearby=[candidate.strip() for candidate in lines[max(0,index-3):index+4] if candidate.strip() and candidate!=line]
                alt=(match.group(1) or "").strip();authored="\n".join(dict.fromkeys(([alt] if alt else [])+nearby)).strip()
                evidence.append({"imagePath":str(image.relative_to(target)),"imageSha256":hashlib.sha256(image.read_bytes()).hexdigest(),"mimeType":mimetypes.guess_type(image.name)[0] or "application/octet-stream","page":None,"section":heading,"authoredContext":authored,"eligible":bool(supported_image(image) and len(authored)>=24)})
    deduplicated={}
    for item in evidence:
        current=deduplicated.get(item["imageSha256"])
        if current is None or (item["eligible"],len(item["authoredContext"]))>(current["eligible"],len(current["authoredContext"])):deduplicated[item["imageSha256"]]=item
    return blocks,list(deduplicated.values())
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
    value=job["input"];job_id=str(job["jobId"]);uri=value.get("objectUri");filename=Path(str(value.get("filename","document"))).name
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
        try:convert_document(source,markdown_target,structured_target,job_id)
        except Exception as error:
            set_status(job_id,"failed",.05)
            raise RuntimeError(f"Marker conversion failed: {safe_error(error)}") from error
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
    set_status(job_id,"complete",.98)
    return{"state":"ready","resultManifest":upload_bundle(target,job_id),"tokenCount":max(1,len(text)//4)}
serve({"/process":process,"/status":status})
