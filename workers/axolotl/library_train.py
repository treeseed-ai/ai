import csv,fcntl,hashlib,json,os,re,shutil,signal,subprocess,threading,time
from collections import deque
from contextlib import contextmanager
from pathlib import Path
import boto3

BASE_MODEL="Qwen/Qwen3.5-4B"
BASE_REVISION="851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
TARGETS=r"model\.language_model\.layers\.[\d]+\.(mlp|self_attn)\.(up|down|gate|q|k|v|o)_proj"
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
PRIVATE_PATH=re.compile(r"(?:(?:/home|/root)/[^\s'\"]+|/run/secrets/[^\s'\"]+)")
QUALIFICATION_SEQUENCES=(4096,3072,2048,1024)
QUALIFICATION_STEPS=8
ALLOCATOR_POLICY="expandable_segments:True"
_PROCESSES={};_STATUS={};_STATUS_ORDER=deque();_PROCESS_LOCK=threading.Lock()

class JobAlreadyRunning(RuntimeError):status_code=409

@contextmanager
def job_guard(root):
    path=root/"execution.lock";handle=path.open("a+")
    try:
        try:fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise JobAlreadyRunning("Axolotl job is already running")
        yield
    finally:handle.close()

def safe_diagnostic(value,limit=2000):
    text=SECRET.sub("[REDACTED]",str(value or ""));text=PRIVATE_PATH.sub("[REDACTED_PATH]",text)
    return text.replace("\x00","")[-limit:].strip()

def terminate(process):
    if process.poll() is not None:return
    try:os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=30)
    except subprocess.TimeoutExpired:
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
        process.wait()
    except ProcessLookupError:process.wait()
def cancel_axolotl(job_id):
    with _PROCESS_LOCK:process=_PROCESSES.get(job_id)
    if process is None:return False
    terminate(process);return True
def progress_from_output(value):
    matches=list(re.finditer(r"(\d{1,3})%\|[^\r\n]*?\|\s*(\d+)\s*/\s*(\d+)",value))
    if not matches:return None
    match=matches[-1];current,total=int(match.group(2)),int(match.group(3))
    if total<1 or current<0 or current>total:return None
    return{"progress":current/total,"currentStep":current,"totalSteps":total,"percent":int(match.group(1))}
def execution_status(job_id):
    with _PROCESS_LOCK:return dict(_STATUS.get(job_id,{"state":"unknown","progress":0}))
def run_process(command,timeout,environment,job_id=None):
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=environment,start_new_session=True,bufsize=0)
    if job_id:
        with _PROCESS_LOCK:
            if job_id in _PROCESSES:terminate(process);raise JobAlreadyRunning("Axolotl job is already running")
            _PROCESSES[job_id]=process
            if job_id not in _STATUS_ORDER:
                while len(_STATUS_ORDER)>=128:_STATUS.pop(_STATUS_ORDER.popleft(),None)
                _STATUS_ORDER.append(job_id)
            _STATUS[job_id]={"state":"running","progress":_STATUS.get(job_id,{}).get("progress",0),"updatedAt":time.time()}
    output=deque(maxlen=256);tail=b""
    def read_output():
        nonlocal tail
        if process.stdout is None:return
        while True:
            chunk=os.read(process.stdout.fileno(),4096)
            if not chunk:break
            output.append(chunk);tail=(tail+chunk)[-8192:]
            if job_id:
                observed=progress_from_output(tail.decode("utf-8",errors="replace"))
                if observed:
                    with _PROCESS_LOCK:
                        current=_STATUS.get(job_id)
                        if current and observed["progress"]>=current.get("progress",0):current.update(observed,updatedAt=time.time())
    reader=threading.Thread(target=read_output,daemon=True);reader.start()
    try:
        process.wait(timeout=timeout);reader.join(timeout=5);value=b"".join(output).decode("utf-8",errors="replace")
        return subprocess.CompletedProcess(command,process.returncode,value)
    except subprocess.TimeoutExpired:
        terminate(process);raise
    finally:
        if job_id:
            with _PROCESS_LOCK:
                if _PROCESSES.get(job_id) is process:
                    _PROCESSES.pop(job_id,None);_STATUS[job_id]={**_STATUS.get(job_id,{}),"state":"succeeded" if process.returncode==0 else "failed","updatedAt":time.time()}
def run_axolotl(config_path,timeout,job_id=None):
    environment=os.environ.copy();environment.setdefault("PYTORCH_CUDA_ALLOC_CONF",ALLOCATOR_POLICY)
    return run_process(["accelerate","launch","-m","axolotl.cli.train",str(config_path)],timeout,environment,job_id)
def run_evaluation(config_path,timeout,job_id=None):
    environment=os.environ.copy();environment.setdefault("PYTORCH_CUDA_ALLOC_CONF",ALLOCATOR_POLICY)
    return run_process(["accelerate","launch","-m","axolotl.cli.evaluate",str(config_path)],timeout,environment,job_id)
def fixed_steps(config,steps,save_steps):
    config.pop("num_epochs",None);config.update({"max_steps":steps,"save_steps":save_steps});return config

def client():return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix):raise ValueError("Library dataset is outside the training bucket")
    return str(uri)[len(prefix):]
def fixed_config(value,dataset,target):
    sequence=int(value["sequenceLength"])
    if sequence not in {1024,2048,3072,4096}:raise ValueError("Training sequence length is not qualified")
    return{"base_model":BASE_MODEL,"revision":BASE_REVISION,"datasets":[{"path":str(dataset),"type":"completion"}],"sequence_len":sequence,"sample_packing":False,"adapter":"qlora","load_in_4bit":True,"lora_r":16,"lora_alpha":32,"lora_dropout":0.05,"lora_target_modules":TARGETS,"bf16":True,"gradient_checkpointing":True,"micro_batch_size":1,"gradient_accumulation_steps":8,"learning_rate":0.0001,"weight_decay":0.01,"warmup_ratio":0.03,"num_epochs":1,"seed":42,"output_dir":str(target),"save_steps":int(value.get("saveSteps",25)),"evals_per_epoch":1}
def evaluation_config(training,evaluation,probe,target,adapter=None):
    config={key:value for key,value in training.items() if key not in {"datasets","output_dir","save_steps","evals_per_epoch","num_epochs","max_steps","warmup_ratio","weight_decay","gradient_checkpointing"}}
    config.update({"datasets":[{"path":str(probe),"type":"completion"}],"test_datasets":[{"path":str(evaluation),"type":"completion"}],"output_dir":str(target),"eval_batch_size":1,"dataset_num_proc":1,"shuffle_merged_datasets":False})
    if adapter is not None:config["lora_model_dir"]=str(adapter)
    return config
def evaluation_loss(path):
    summary=path/"eval_summary.csv"
    if not summary.exists():raise RuntimeError("Axolotl evaluation did not produce eval_summary.csv")
    with summary.open(newline="",encoding="utf-8") as source:
        for row in csv.DictReader(source):
            if row.get("metric")=="loss" and row.get("validation") not in {None,""}:return float(row["validation"])
    raise RuntimeError("Axolotl evaluation did not report validation loss")
def evaluate_pair(config,evaluation,target,job_id):
    probe=target/"evaluation-probe.jsonl";probe.write_text(next(line for line in evaluation.read_text().splitlines() if line.strip())+"\n")
    values={}
    for name,adapter in (("base",None),("candidate",target/"adapter")):
        output=target/f"evaluate-{name}";output.mkdir(exist_ok=True);path=target/f"evaluate-{name}.json";path.write_text(json.dumps(evaluation_config(config,evaluation,probe,output,adapter),sort_keys=True,separators=(",",":")))
        execution=run_evaluation(path,int(os.getenv("EVALUATE_TIMEOUT","86400")),job_id)
        if execution.returncode:raise RuntimeError(f"Axolotl {name} evaluation exited {execution.returncode}: {safe_diagnostic(execution.stdout) or 'no diagnostic output'}")
        values[name]=evaluation_loss(output)
        shutil.rmtree(output,ignore_errors=True)
    return{"schemaVersion":"ai.library-likelihood-evaluation/v1","metric":"completion-negative-log-likelihood","baseValue":values["base"],"candidateValue":values["candidate"],"evaluationObject":{"sha256":hashlib.sha256(evaluation.read_bytes()).hexdigest(),"size":evaluation.stat().st_size},"evaluator":{"engine":"axolotl","version":"0.18.0","baseModel":BASE_MODEL,"baseRevision":BASE_REVISION,"baseline":"fresh-zero-effect-qlora"}}
def train(job):
    value=job["input"]
    if value.get("baseModel")!=BASE_MODEL or value.get("baseModelRevision")!=BASE_REVISION:raise ValueError("Library training requires the immutable qualified base revision")
    if value.get("mode") not in {"smoke","standard"}:raise ValueError("Library mode must be smoke or standard")
    root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/job["jobId"];root.mkdir(parents=True,exist_ok=True);result=root/"result.json"
    with job_guard(root):
        if result.exists():
            existing=json.loads(result.read_text());return{"resultManifest":f"file://{result}","configurationDigest":existing["configDigest"],"evaluations":existing.get("evaluations",[])}
        dataset=root/"train.jsonl";dataset.write_bytes(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["trainUri"]))["Body"].read())
        target=root/"adapter";config=fixed_config(value,dataset,target)
        if value["mode"]=="smoke":fixed_steps(config,16,8)
        config_path=root/"axolotl.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
        execution=run_axolotl(config_path,int(os.getenv("TRAIN_TIMEOUT","86400")),job["jobId"])
        if execution.returncode:raise RuntimeError(f"Axolotl training exited {execution.returncode}: {safe_diagnostic(execution.stdout) or 'no diagnostic output'}")
        evaluations=[]
        if value["mode"]=="standard":
            if not value.get("evaluationUri"):raise ValueError("Standard library training requires an immutable held-out corpus")
            evaluation=root/"evaluation.jsonl";evaluation.write_bytes(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["evaluationUri"]))["Body"].read());evaluations.append(evaluate_pair(config,evaluation,root,job["jobId"]))
        payload={"schemaVersion":"ai.library-training-result/v1","baseModel":BASE_MODEL,"baseModelRevision":BASE_REVISION,"adapterPath":str(target),"config":str(config_path),"configDigest":hashlib.sha256(config_path.read_bytes()).hexdigest(),"mode":value["mode"],"libraryId":value["libraryId"],"librarySlug":value["librarySlug"],"snapshotId":value["snapshotId"],"datasetManifest":value["datasetManifest"],"targetModules":[TARGETS],"rank":16,"alpha":32,"evaluations":evaluations}
        result.write_text(json.dumps(payload,sort_keys=True,separators=(",",":")));return{"resultManifest":f"file://{result}","configurationDigest":payload["configDigest"],"evaluations":evaluations}
def qualify(job):
    value=job["input"];identity=subprocess.check_output(["nvidia-smi","--query-gpu=uuid,driver_version","--format=csv,noheader"],text=True).strip();fingerprint=hashlib.sha256(f"{identity}|{os.getenv('TREEAI_IMAGE_ID','unknown')}|{BASE_REVISION}|r16|mb1|ga8|q{QUALIFICATION_STEPS}|{ALLOCATOR_POLICY}".encode()).hexdigest();root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/f"qualification-{fingerprint}";root.mkdir(parents=True,exist_ok=True);dataset=root/"train.jsonl"
    with job_guard(root):
        if not dataset.exists():dataset.write_bytes(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["trainUri"]))["Body"].read())
        failures=[]
        for sequence in QUALIFICATION_SEQUENCES:
            target=root/f"seq-{sequence}";shutil.rmtree(target,ignore_errors=True);config=fixed_steps(fixed_config({"sequenceLength":sequence},dataset,target),QUALIFICATION_STEPS,QUALIFICATION_STEPS);config_path=root/f"seq-{sequence}.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
            try:
                execution=run_axolotl(config_path,int(os.getenv("QUALIFY_TIMEOUT","3600")),job["jobId"])
                if execution.returncode==0:shutil.rmtree(target,ignore_errors=True);return{"resultManifest":f"profile://{sequence}","sequenceLength":sequence,"fingerprint":fingerprint,"diagnostics":{"failed":failures}}
                failures.append({"sequenceLength":sequence,"exitCode":execution.returncode,"diagnostic":safe_diagnostic(execution.stdout) or "no diagnostic output"})
            except subprocess.TimeoutExpired as error:failures.append({"sequenceLength":sequence,"error":"TimeoutExpired","diagnostic":safe_diagnostic(error.stdout)})
            shutil.rmtree(target,ignore_errors=True)
        raise ValueError(f"No library training sequence length of at least 1024 tokens qualified: {json.dumps(failures,separators=(',',':'))}")
