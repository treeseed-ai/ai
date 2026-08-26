import base64, hashlib, json, mimetypes, os, re, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from sys import path
import boto3

path.insert(0, "/app")
from common.server import serve

STATE = Path(os.getenv("STATE_DIR", "/state")); STATE.mkdir(parents=True, exist_ok=True)
PRIVATE_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
class PrivateHttpError(RuntimeError):
    def __init__(self,status,detail):
        self.status=status
        super().__init__(f"private vLLM HTTP {status}: {detail or 'empty response'}")
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
    response=json.loads(PRIVATE_OPENER.open(request,timeout=240).read());return response["choices"][0]["message"]
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
def object_bytes(uri):
    try:return s3_client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(uri))["Body"].read()
    except Exception as error:raise RuntimeError(f"inference object store read failed: {type(error).__name__}") from error
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not uri.startswith(prefix): raise ValueError("Copied adapter object is outside the inference bucket")
    return uri[len(prefix):]
def post(path, body):
    request=urllib.request.Request(f"{os.getenv('VLLM_URL','http://vllm:8000')}{path}", data=json.dumps(body).encode(), headers={"content-type":"application/json"})
    try:return PRIVATE_OPENER.open(request, timeout=240).read()
    except urllib.error.HTTPError as error:
        detail=error.read(1024).decode("utf-8",errors="replace").replace("\n"," ").strip()
        raise PrivateHttpError(error.code,detail) from error
    except urllib.error.URLError as error:raise RuntimeError(f"private vLLM request failed: {type(error.reason).__name__}") from error
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
    except PrivateHttpError as error:
        if error.status not in {400,404}: raise
    post("/v1/load_lora_adapter",{"lora_name":candidate,"lora_path":str(target)})
    with ThreadPoolExecutor(max_workers=2) as pool:list(pool.map(lambda _:post("/v1/chat/completions",{"model":candidate,"messages":[{"role":"user","content":"Reply with ready."}],"max_tokens":8}),range(2)))
    return write(job,"deployment",{"action":action,"candidateId":candidate,"warm":True})
def canary(job):
    candidate=str(job["input"]["candidateId"])
    composed=job["input"].get("manifest",{}).get("sourceManifest",{}).get("adapter",{}).get("modality")=="composed";pixel="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    requests=[{"model":candidate,"messages":[{"role":"user","content":"Reply with canary-one."}],"temperature":0,"max_tokens":32},{"model":candidate,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":f"data:image/png;base64,{pixel}"}},{"type":"text","text":"Confirm that an image was supplied without guessing its subject."}]}],"temperature":0,"max_tokens":32}] if composed else [{"model":candidate,"messages":[{"role":"user","content":"Reply with canary-two."}],"temperature":0,"max_tokens":32}]
    with ThreadPoolExecutor(max_workers=2) as pool: responses=list(pool.map(lambda body:post("/v1/chat/completions",body),requests))
    if any(not json.loads(value)["choices"][0]["message"].get("content") for value in responses):raise ValueError("Canary response was empty")
    return write(job,"canary",{"candidateId":candidate,"passed":True,"concurrency":2,"multimodal":composed})

def visual_grounding(job):
    value=job["input"];model=str(value["candidateId"]);stored=value.get("evaluationObject",{});evaluation=stored.get("evaluation",{});images={item["relativePath"]:item for item in stored.get("images",[])}
    if not evaluation.get("uri") or not images:raise ValueError("A copied held-out visual corpus and images are required")
    lines=object_bytes(evaluation["uri"]).decode();scores=[]
    for line in lines.splitlines():
        if not line.strip():continue
        example=json.loads(line);messages=example.get("messages",[]);expected=" ".join(part.get("text","") for part in messages[-1].get("content",[]) if part.get("type")=="text");prompt=json.loads(json.dumps(messages[:-1]))
        for message in prompt:
            for part in message.get("content",[]):
                if part.get("type")!="image":continue
                item=images.get(part.get("path"));
                if not item:raise ValueError("Visual example references an unavailable image")
                data=object_bytes(item["uri"]);mime=mimetypes.guess_type(part["path"])[0] or "image/png";part.clear();part.update({"type":"image_url","image_url":{"url":f"data:{mime};base64,{base64.b64encode(data).decode()}"}})
        response=json.loads(post("/v1/chat/completions",{"model":model,"messages":prompt,"temperature":0,"max_tokens":256}));actual=response["choices"][0]["message"].get("content","");expected_words=set(re.findall(r"[a-z0-9]{4,}",expected.lower()));actual_words=set(re.findall(r"[a-z0-9]{4,}",actual.lower()));scores.append(len(expected_words&actual_words)/max(1,len(expected_words)))
    if not scores:raise ValueError("Held-out visual corpus has no evaluable examples")
    return write(job,"visual-grounding",{"candidateId":model,"metric":"authored-context-token-recall","value":sum(scores)/len(scores),"examples":len(scores),"evaluationObject":{"sha256":evaluation.get("sha256"),"size":evaluation.get("size")}})
def library_likelihood(job):
    value=job["input"];model=str(value["candidateId"]);stored=value.get("evaluationObject",{});uri=stored.get("uri","")
    if not uri:raise ValueError("A copied held-out evaluation object is required")
    body=object_bytes(uri).decode("utf-8");losses=[];tokens=0
    for line in body.splitlines():
        if not line.strip():continue
        prompt=json.loads(line).get("text","")
        if not prompt:continue
        response=json.loads(post("/v1/completions",{"model":model,"prompt":prompt,"max_tokens":1,"temperature":0,"prompt_logprobs":1}))
        values=response.get("choices",[{}])[0].get("prompt_logprobs") or response.get("prompt_logprobs") or []
        for entry in values:
            if not isinstance(entry,dict) or not entry:continue
            chosen=next(iter(entry.values()));logprob=chosen.get("logprob") if isinstance(chosen,dict) else chosen
            if isinstance(logprob,(int,float)):losses.append(-float(logprob));tokens+=1
    if not losses:raise ValueError("vLLM returned no held-out prompt log probabilities")
    return write(job,"library-likelihood",{"candidateId":model,"metric":"completion-negative-log-likelihood","value":sum(losses)/len(losses),"tokenCount":tokens,"evaluationObject":{"sha256":stored.get("sha256"),"size":stored.get("size")}})
def state_manifest(uri):
    target=Path(str(uri)[7:]).resolve() if str(uri).startswith("file://") else None
    if not target or STATE not in target.parents:raise ValueError("Evaluation manifest is outside evaluator state")
    return json.loads(target.read_text())
def rank_library(job):
    value=job["input"];general=state_manifest(value["generalManifest"]);evidence=value.get("likelihoodEvidence",{});candidate_id=str(value["candidateId"])
    if evidence.get("schemaVersion")!="ai.library-likelihood-evaluation/v1" or evidence.get("metric")!="completion-negative-log-likelihood":raise ValueError("Signed Axolotl likelihood evidence is required")
    general_results=general.get("results",[]);active_general=next((item for item in general_results if item["candidate"]!=candidate_id),None);candidate_general=next((item for item in general_results if item["candidate"]==candidate_id),None);reasons=[]
    if not active_general or not candidate_general:reasons.append("base and candidate general evaluations are required")
    else:
        if not candidate_general.get("criticalChecksPassed"):reasons.append("critical general checks failed")
        regressions=[key for key,score in candidate_general.get("categories",{}).items() if score<active_general.get("categories",{}).get(key,0)]
        if regressions:reasons.append("general category regressions: "+", ".join(regressions))
    base_nll=float(evidence["baseValue"]);candidate_nll=float(evidence["candidateValue"])
    if candidate_nll>base_nll*0.98:reasons.append("held-out completion NLL did not improve by at least 2 percent")
    visual=None
    if value.get("baseVisualManifest") or value.get("candidateVisualManifest"):
        if not value.get("baseVisualManifest") or not value.get("candidateVisualManifest"):reasons.append("both base and candidate visual evaluations are required")
        else:
            base_visual=state_manifest(value["baseVisualManifest"]);candidate_visual=state_manifest(value["candidateVisualManifest"]);base_score=float(base_visual["value"]);candidate_score=float(candidate_visual["value"]);visual={"base":base_score,"candidate":candidate_score}
            if candidate_score<=base_score:reasons.append("held-out visual grounding did not improve")
    return write(job,"library-ranking",{"policy":"library-strict-improvement-v1","policyVersion":"2","candidateId":candidate_id,"baseNegativeLogLikelihood":base_nll,"candidateNegativeLogLikelihood":candidate_nll,"improvement":(base_nll-candidate_nll)/base_nll if base_nll else 0,"visualGrounding":visual,"promotable":not reasons,"ranking":[{"candidate":candidate_id}],"explanation":"; ".join(reasons) if reasons else "Text likelihood, visual grounding, general behavior, and critical gates passed."})

serve({"/import": import_adapter, "/evaluate": evaluate, "/library-likelihood":library_likelihood, "/visual-grounding":visual_grounding, "/rank": rank, "/rank-library":rank_library, "/authorize":authorize, "/canary":canary, "/promote": lambda job: deployment(job, "promote"), "/rollback": lambda job: deployment(job, "rollback")})
