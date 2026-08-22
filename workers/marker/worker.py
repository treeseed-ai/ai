import hashlib, json, os, subprocess, tempfile
import boto3
from pathlib import Path
from sys import path
path.insert(0, "/app")
from common.server import serve

OUTPUT=Path(os.getenv("OUTPUT_DIR", "/artifacts/documents"));OUTPUT.mkdir(parents=True,exist_ok=True)
def upload_bundle(target,job_id):
    client=boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"]);bucket=os.environ["S3_BUCKET"]
    for item in target.rglob("*"):
        if item.is_file(): client.upload_file(str(item),bucket,f"documents/{job_id}/{item.relative_to(target)}")
    return f"s3://{bucket}/documents/{job_id}/manifest.json"
def process(job):
    source=job["input"].get("sourcePath")
    if not source or not str(source).endswith(".pdf"): raise ValueError("sourcePath must identify a PDF mounted inside the worker")
    source_path=Path(source).resolve();allowed=Path(os.getenv("INPUT_DIR","/inputs")).resolve()
    if allowed not in source_path.parents or not source_path.is_file(): raise ValueError("PDF is outside the mounted input directory")
    target=OUTPUT/job["jobId"];target.mkdir(exist_ok=True)
    if (target/"manifest.json").exists(): return{"resultManifest":upload_bundle(target,job["jobId"])}
    subprocess.run(["marker_single",str(source_path),"--output_dir",str(target)],check=True,timeout=int(os.getenv("MARKER_TIMEOUT","3600")))
    objects=[]
    for item in sorted(target.rglob("*")):
        if item.is_file(): objects.append({"path":str(item.relative_to(target)),"size":item.stat().st_size,"sha256":hashlib.sha256(item.read_bytes()).hexdigest()})
    manifest={"schemaVersion":"ai.document-bundle/v1","source":{"name":source_path.name,"sha256":hashlib.sha256(source_path.read_bytes()).hexdigest()},"objects":objects,"provenance":{"processor":"marker"}}
    manifest_path=target/"manifest.json";manifest_path.write_text(json.dumps(manifest,sort_keys=True));return{"resultManifest":upload_bundle(target,job["jobId"])}
serve({"/process":process})
