import base64, hashlib, json, os, re, shutil
from pathlib import Path
from sys import path
path.insert(0,"/app")
from common.server import serve
from common.artifacts import ArtifactRepository
from canonical_json import canonical,json_bytes
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from library import classify as classify_library
from composition import compose as compose_adapters

ROOT=Path(os.getenv("ARTIFACT_ROOT","/artifacts")).resolve();ARCHIVE=Path(os.getenv("ARCHIVE_ROOT","/archive")).resolve();ROOT.mkdir(parents=True,exist_ok=True);ARCHIVE.mkdir(parents=True,exist_ok=True)
KEY_PATH=Path(os.getenv("SIGNING_KEY","/run/secrets/artifact-signing-key"))
REPOSITORY=ArtifactRepository.from_env()
def safe(value,base=ROOT):
    target=Path(value).resolve()
    if base not in target.parents and target!=base: raise ValueError("Path is outside the artifact root")
    return target
def sign_manifest(manifest):
    key=serialization.load_pem_private_key(KEY_PATH.read_bytes(),password=None)
    if not isinstance(key,Ed25519PrivateKey): raise ValueError("Signing key must be Ed25519")
    return{**manifest,"signature":base64.b64encode(key.sign(canonical(manifest))).decode()}
def upload(path,key):return REPOSITORY.put_file(key,path)["uri"]
def compose(job):return compose_adapters(job,REPOSITORY,KEY_PATH,upload,sign_manifest)
def dataset(job):
    sources=job["input"].get("sources",[])
    if not sources: raise ValueError("sources are required")
    manifest={"schemaVersion":"ai.dataset/v1","sources":sources,"format":"jsonl","provenance":{"jobId":job["jobId"]}}
    target=ROOT/"datasets"/f"{job['jobId']}.json";target.parent.mkdir(exist_ok=True);target.write_bytes(json_bytes(manifest));return{"resultManifest":upload(target,f"datasets/{job['jobId']}.json")}
SECRET=re.compile(r"(?i)(ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+|/home/[^/\s]+)")
def clean(value):
    if isinstance(value,str): return SECRET.sub("[REDACTED]",value)
    if isinstance(value,list): return [clean(item) for item in value]
    if isinstance(value,dict): return {key:clean(item) for key,item in value.items() if key.lower() not in {"authorization","cookie","api_key","token","password","secret"}}
    return value
def validate_experience(manifest):
    if manifest.get("schemaVersion")!="ai.experience-batch/v1" or not manifest.get("batchId"): raise ValueError("Invalid experience batch schema")
    trajectories=manifest.get("trajectories")
    if not isinstance(trajectories,list) or not trajectories: raise ValueError("Experience batch has no trajectories")
    seen=set()
    for item in trajectories:
        if not item.get("id") or item["id"] in seen or not isinstance(item.get("messages"),list): raise ValueError("Malformed or duplicate trajectory")
        seen.add(item["id"])
        for artifact in item.get("artifacts",[]):
            if not re.fullmatch(r"[a-f0-9]{64}",artifact.get("sha256","")): raise ValueError("Artifact is not content-addressed")
            body=REPOSITORY.bytes(artifact["uri"])
            if len(body)!=artifact.get("size") or hashlib.sha256(body).hexdigest()!=artifact["sha256"]: raise ValueError("Experience artifact checksum or size does not match")
    return clean(manifest)
def experience_register(job):
    manifest=validate_experience(job["input"].get("manifest",{}));target=ROOT/"experience"/f"{manifest['batchId']}.json";target.parent.mkdir(exist_ok=True);target.write_bytes(json_bytes(manifest));return{"resultManifest":upload(target,f"experience/{manifest['batchId']}.json"),"trajectoryCount":len(manifest["trajectories"])}
def experience(job):
    manifest=validate_experience(job["input"].get("manifest",{}));target=ROOT/"datasets"/f"{job['jobId']}.jsonl";target.parent.mkdir(exist_ok=True)
    with target.open("w") as output:
        for trajectory in manifest["trajectories"]:
            if float(trajectory.get("reward",0))<1 and not trajectory.get("critic",{}).get("validated"): continue
            messages=trajectory["messages"]
            if trajectory.get("critic",{}).get("validated") and trajectory["critic"].get("answer") is not None: messages=[*messages[:-1],{"role":"assistant","content":trajectory["critic"]["answer"]}]
            if not messages or messages[-1].get("role")!="assistant": continue
            output.write(json.dumps({"messages":messages,"metadata":{"trajectoryId":trajectory["id"],"source":trajectory.get("sourceClient"),"artifacts":trajectory.get("artifacts",[])}},sort_keys=True)+"\n")
    if target.stat().st_size==0: raise ValueError("No verified assistant examples remain")
    uri=upload(target,f"datasets/{job['jobId']}.jsonl");manifest_path=target.with_suffix(".manifest.json");manifest_path.write_bytes(json_bytes({"schemaVersion":"ai.dataset/v1","format":"chat-jsonl","objects":[{"uri":uri,"sha256":hashlib.sha256(target.read_bytes()).hexdigest(),"size":target.stat().st_size}],"sourceBatch":manifest["batchId"],"provenance":{"jobId":job["jobId"]}}));return{"resultManifest":upload(manifest_path,f"datasets/{job['jobId']}.manifest.json")}
def export_adapter(job):
    result_uri=job["input"].get("adapterResultUri","")
    if not result_uri.startswith("file://"): raise ValueError("adapterResultUri must be an internal file URI")
    result_path=safe(result_uri[7:]);result=json.loads(result_path.read_text());adapter=safe(result["adapterPath"])
    revision=job["input"].get("baseModelRevision")
    if not revision: raise ValueError("baseModelRevision is required for immutable compatibility")
    objects=[]
    for item in sorted(adapter.rglob("*")):
        if item.is_file() and item!=result_path:
            checksum=hashlib.sha256(item.read_bytes()).hexdigest();relative=str(item.relative_to(adapter));uri=upload(item,f"adapters/{job['jobId']}/{relative}");objects.append({"uri":uri,"size":item.stat().st_size,"sha256":checksum})
    library=result.get("schemaVersion") in {"ai.library-training-result/v1","ai.library-training-result/v2"};modality=result.get("modality","language")
    evaluations=result.get("evaluations",[]) if library else job["input"].get("evaluations",[])
    for evidence in evaluations:
        if evidence.get("schemaVersion")!="ai.library-likelihood-evaluation/v1" or evidence.get("metric")!="completion-negative-log-likelihood" or not all(isinstance(evidence.get(key),(int,float)) for key in ("baseValue","candidateValue")):raise ValueError("Library likelihood evidence is malformed")
    manifest={"schemaVersion":"ai.artifact/v3" if result.get("schemaVersion")=="ai.library-training-result/v2" else ("ai.artifact/v2" if library else "ai.artifact/v1"),"artifactId":job["jobId"],"artifactType":"lora-adapter","createdAt":job["input"].get("createdAt"),"baseModel":{"id":result["baseModel"],"revision":revision},"trainingConfigDigest":hashlib.sha256(Path(result["config"]).read_bytes()).hexdigest(),"datasets":[result["datasetManifest"]] if library else job["input"].get("datasetManifests",[]),"adapter":{"format":"peft","architecture":job["input"].get("architecture","causal-lm"),"purpose":"continual-pretraining","modality":modality,"targetModules":result.get("targetModules",[]),"rank":result.get("rank"),"alpha":result.get("alpha")},"library":({"id":result["libraryId"],"slug":result["librarySlug"],"snapshotId":result["snapshotId"],"mode":result["mode"],"promotionEligible":result["mode"]=="standard"} if library else None),"objects":objects,"evaluations":evaluations,"provenance":{"trainingJobId":job["jobId"]},"signingKeyId":os.getenv("SIGNING_KEY_ID","default")}
    signed=sign_manifest(manifest);target=adapter/"artifact-manifest.json";target.write_bytes(json_bytes(signed));return{"resultManifest":upload(target,f"manifests/{job['jobId']}.json")}
def verify(job):
    target=safe(job["input"].get("path",""));expected=job["input"].get("sha256");actual=hashlib.sha256(target.read_bytes()).hexdigest()
    if expected and expected!=actual: raise ValueError("Artifact checksum does not match")
    return{"resultManifest":f"file://{target}","sha256":actual}
def archive(job):
    source=safe(job["input"].get("path",""));target=ARCHIVE/job["jobId"];shutil.copytree(source,target);manifest={"schemaVersion":"ai.artifact/v1","artifactId":job["jobId"],"artifactType":"archive","createdAt":job["input"].get("createdAt"),"objects":[],"provenance":{"source":str(source)},"signingKeyId":os.getenv("SIGNING_KEY_ID","default")}
    signed=sign_manifest(manifest);manifest_path=target/"manifest.json";manifest_path.write_bytes(canonical(signed));return{"resultManifest":f"file://{manifest_path}"}
def restore(job):
    source=(ARCHIVE/job["input"].get("archiveId",job["jobId"])).resolve()
    if ARCHIVE not in source.parents or not source.is_dir(): raise ValueError("Archive does not exist")
    target=ROOT/"restored"/job["jobId"];shutil.copytree(source,target);return{"resultManifest":f"file://{target/'manifest.json'}"}
serve({"/classify-library-document":classify_library,"/dataset":dataset,"/experience-register":experience_register,"/experience":experience,"/verify":verify,"/archive":archive,"/restore":restore,"/export-adapter":export_adapter,"/compose-library-adapters":compose})
