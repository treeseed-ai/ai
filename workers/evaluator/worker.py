import hashlib, json, os, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from sys import path
import boto3

path.insert(0, "/app")
from common.server import serve

STATE = Path(os.getenv("STATE_DIR", "/state")); STATE.mkdir(parents=True, exist_ok=True)
def digest(value): return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
def write(job, kind, value):
    target = STATE / f"{job['jobId']}-{kind}.json"; target.write_text(json.dumps(value, sort_keys=True)); return {"resultManifest": f"file://{target}"}
def import_adapter(job):
    source = job["input"].get("manifestUri")
    if not source: raise ValueError("manifestUri is required")
    return write(job, "candidate", {"manifestUri": source, "status": "inactive"})
def completion(model,case):
    body={"model":model,"messages":case["messages"],"temperature":0,"max_tokens":case.get("maxTokens",256)}
    request=urllib.request.Request(f"{os.getenv('VLLM_URL','http://vllm:8000')}/v1/chat/completions",data=json.dumps(body).encode(),headers={"content-type":"application/json"})
    response=json.loads(urllib.request.urlopen(request,timeout=240).read());return response["choices"][0]["message"]
def case_score(case,message):
    text=str(message.get("content") or "");check=case.get("check",{})
    if "contains" in check:return float(all(value.lower() in text.lower() for value in check["contains"]))
    if check.get("json"):
        try: value=json.loads(text);return float(all(key in value for key in check.get("keys",[])))
        except Exception:return 0.0
    if "tool" in check:return float(any(item.get("function",{}).get("name")==check["tool"] for item in message.get("tool_calls",[])))
    return float(bool(text.strip()))
def load_suite(name):
    safe_name=Path(name).name
    if safe_name!=name:raise ValueError("Invalid suite name")
    path=Path(os.getenv("SUITE_DIR","/app/suites"))/f"{name}.json"
    value=json.loads(path.read_text());
    if value.get("schemaVersion")!="ai.evaluation-suite/v1":raise ValueError("Invalid evaluation suite")
    return value
def evaluate(job):
    candidates = job["input"].get("candidates", [])
    if not candidates: raise ValueError("At least one candidate is required")
    suite_name=job["input"].get("suite","default-v1");suite=load_suite(suite_name);results=[]
    for item in candidates:
        model=item if isinstance(item,str) else item["model"]
        if isinstance(item,dict) and item.get("manifest"): deployment({"jobId":job["jobId"],"input":{"candidateId":model,"manifest":item["manifest"]}},"evaluate")
        categories={};critical=True;details=[]
        for case in suite["cases"]:
            try: score=case_score(case,completion(model,case))
            except Exception as error: score=0.0;details.append({"id":case["id"],"error":str(error)})
            categories.setdefault(case["category"],[]).append(score);critical=critical and (not case.get("critical") or score==1)
        normalized={key:sum(values)/len(values) for key,values in categories.items()};results.append({"candidate":model,"score":sum(normalized.values())/len(normalized),"categories":normalized,"criticalChecksPassed":critical,"details":details})
    return write(job,"evaluation",{"suite":suite_name,"suiteDigest":digest(suite),"results":results})
def rank(job):
    results = job["input"].get("results", [])
    for uri in job["input"].get("evaluationManifests",[]):
        if not str(uri).startswith("file://") or STATE not in Path(str(uri)[7:]).resolve().parents:raise ValueError("Invalid evaluation manifest")
        results.extend(json.loads(Path(str(uri)[7:]).read_text()).get("results",[]))
    ranked=sorted(results,key=lambda item:(-float(item["score"]),str(item["candidate"])))
    active=next((item for item in results if item["candidate"]==job["input"].get("activeCandidate")),None);candidate=next((item for item in results if item["candidate"]==job["input"].get("candidate")),ranked[0] if ranked else None);reasons=[]
    if not active or not candidate:reasons.append("active and candidate evaluation results are required")
    else:
        if not candidate.get("criticalChecksPassed"):reasons.append("critical checks failed")
        regressions=[key for key,value in candidate.get("categories",{}).items() if value<active.get("categories",{}).get(key,0)]
        if regressions:reasons.append("category regressions: "+", ".join(regressions))
        if float(candidate["score"])-float(active["score"])<0.02:reasons.append("aggregate improvement is below 0.02")
    return write(job,"ranking",{"policy":"strict-improvement-v1","policyVersion":"1","ranking":ranked,"promotable":not reasons,"explanation":"; ".join(reasons) if reasons else "All critical checks passed with no regressions and at least 0.02 aggregate improvement."})
def authorize(job):
    uri=job["input"].get("rankingManifest","");target=Path(str(uri)[7:]).resolve() if str(uri).startswith("file://") else None
    if not target or STATE not in target.parents:raise ValueError("A local ranking manifest is required")
    ranking=json.loads(target.read_text());candidate=job["input"].get("candidateId")
    if not ranking.get("promotable") or ranking.get("ranking",[{}])[0].get("candidate")!=candidate:raise ValueError("Strict promotion gate rejected candidate")
    return{"resultManifest":uri,"authorized":True}
def s3_client():
    return boto3.client("s3", endpoint_url=os.environ["AWS_ENDPOINT_URL"], region_name=os.getenv("AWS_REGION", "us-east-1"), aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not uri.startswith(prefix): raise ValueError("Copied adapter object is outside the inference bucket")
    return uri[len(prefix):]
def post(path, body):
    request=urllib.request.Request(f"{os.getenv('VLLM_URL','http://vllm:8000')}{path}", data=json.dumps(body).encode(), headers={"content-type":"application/json"})
    return urllib.request.urlopen(request, timeout=240).read()
def deployment(job, action):
    candidate=str(job["input"]["candidateId"]); value=job["input"]["manifest"]
    source=value["sourceManifest"]; copied=value["copiedObjects"]
    target=STATE/"adapters"/candidate; target.mkdir(parents=True, exist_ok=True)
    client=s3_client()
    for original, stored in zip(source["objects"], copied, strict=True):
        marker=f"/adapters/{source['artifactId']}/";relative=original["uri"].split(marker,1)[-1];name=Path(relative)
        if marker not in original["uri"] or name.is_absolute() or ".." in name.parts: raise ValueError("Adapter object has no safe relative path")
        destination=target/name;destination.parent.mkdir(parents=True,exist_ok=True);client.download_file(os.environ["S3_BUCKET"],key(stored["uri"]),str(destination))
    try: post("/v1/unload_lora_adapter",{"lora_name":candidate})
    except urllib.error.HTTPError as error:
        if error.code not in {400,404}: raise
    post("/v1/load_lora_adapter",{"lora_name":candidate,"lora_path":str(target)})
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:post("/v1/chat/completions",{"model":candidate,"messages":[{"role":"user","content":"Reply with ready."}],"max_tokens":8}),range(2)))
    return write(job,"deployment",{"action":action,"candidateId":candidate,"warm":True})
def canary(job):
    candidate=str(job["input"]["candidateId"])
    with ThreadPoolExecutor(max_workers=2) as pool: responses=list(pool.map(lambda prompt:post("/v1/chat/completions",{"model":candidate,"messages":[{"role":"user","content":prompt}],"temperature":0,"max_tokens":32}),["Reply with canary-one.","Reply with canary-two."]))
    if any(not json.loads(value)["choices"][0]["message"].get("content") for value in responses):raise ValueError("Canary response was empty")
    return write(job,"canary",{"candidateId":candidate,"passed":True,"concurrency":2})

serve({"/import": import_adapter, "/evaluate": evaluate, "/rank": rank, "/authorize":authorize, "/canary":canary, "/promote": lambda job: deployment(job, "promote"), "/rollback": lambda job: deployment(job, "rollback")})
