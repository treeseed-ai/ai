import hashlib,json,os,re,shutil,subprocess
from pathlib import Path
import boto3

BASE_MODEL="Qwen/Qwen3.5-4B"
BASE_REVISION="851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
TARGETS=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"]
SECRET=re.compile(r"(?im)(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ak_[a-z0-9-]+_[a-z0-9_-]{16,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s]{12,})")
PRIVATE_PATH=re.compile(r"(?:(?:/home|/root)/[^\s'\"]+|/run/secrets/[^\s'\"]+)")

def safe_diagnostic(value,limit=2000):
    text=SECRET.sub("[REDACTED]",str(value or ""));text=PRIVATE_PATH.sub("[REDACTED_PATH]",text)
    return text.replace("\x00","")[-limit:].strip()

def run_axolotl(config_path,timeout):
    command=["accelerate","launch","-m","axolotl.cli.train",str(config_path)]
    return subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=timeout)

def client():return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix):raise ValueError("Library dataset is outside the training bucket")
    return str(uri)[len(prefix):]
def fixed_config(value,dataset,target):
    sequence=int(value["sequenceLength"])
    if sequence not in {1024,2048,3072,4096}:raise ValueError("Training sequence length is not qualified")
    return{"base_model":BASE_MODEL,"revision":BASE_REVISION,"datasets":[{"path":str(dataset),"type":"completion"}],"sequence_len":sequence,"sample_packing":True,"adapter":"qlora","load_in_4bit":True,"lora_r":16,"lora_alpha":32,"lora_dropout":0.05,"lora_target_modules":TARGETS,"bf16":True,"gradient_checkpointing":True,"micro_batch_size":1,"gradient_accumulation_steps":8,"learning_rate":0.0001,"weight_decay":0.01,"warmup_ratio":0.03,"num_epochs":1,"seed":42,"output_dir":str(target),"save_steps":int(value.get("saveSteps",25)),"evals_per_epoch":1}
def train(job):
    value=job["input"]
    if value.get("baseModel")!=BASE_MODEL or value.get("baseModelRevision")!=BASE_REVISION:raise ValueError("Library training requires the immutable qualified base revision")
    if value.get("mode") not in {"smoke","standard"}:raise ValueError("Library mode must be smoke or standard")
    root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/job["jobId"];root.mkdir(parents=True,exist_ok=True);result=root/"result.json"
    if result.exists():
        existing=json.loads(result.read_text());return{"resultManifest":f"file://{result}","configurationDigest":existing["configDigest"]}
    dataset=root/"train.jsonl";dataset.write_bytes(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["trainUri"]))["Body"].read())
    target=root/"adapter";config=fixed_config(value,dataset,target)
    if value["mode"]=="smoke":config.update({"max_steps":16,"num_epochs":None,"save_steps":8})
    config_path=root/"axolotl.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
    execution=run_axolotl(config_path,int(os.getenv("TRAIN_TIMEOUT","86400")))
    if execution.returncode:raise RuntimeError(f"Axolotl training exited {execution.returncode}: {safe_diagnostic(execution.stdout,12000) or 'no diagnostic output'}")
    payload={"schemaVersion":"ai.library-training-result/v1","baseModel":BASE_MODEL,"baseModelRevision":BASE_REVISION,"adapterPath":str(target),"config":str(config_path),"configDigest":hashlib.sha256(config_path.read_bytes()).hexdigest(),"mode":value["mode"],"libraryId":value["libraryId"],"librarySlug":value["librarySlug"],"snapshotId":value["snapshotId"],"datasetManifest":value["datasetManifest"],"targetModules":TARGETS,"rank":16,"alpha":32}
    result.write_text(json.dumps(payload,sort_keys=True,separators=(",",":")));return{"resultManifest":f"file://{result}","configurationDigest":payload["configDigest"]}
def qualify(job):
    value=job["input"];identity=subprocess.check_output(["nvidia-smi","--query-gpu=uuid,driver_version","--format=csv,noheader"],text=True).strip();fingerprint=hashlib.sha256(f"{identity}|{os.getenv('TREEAI_IMAGE_ID','unknown')}|{BASE_REVISION}|r16|mb1|ga8".encode()).hexdigest();root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/f"qualification-{fingerprint}";root.mkdir(parents=True,exist_ok=True);dataset=root/"train.jsonl"
    if not dataset.exists():dataset.write_bytes(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["trainUri"]))["Body"].read())
    failures=[]
    for sequence in [4096,3072,2048,1024]:
        target=root/f"seq-{sequence}";config=fixed_config({"sequenceLength":sequence},dataset,target);config.update({"max_steps":1,"num_epochs":None,"save_steps":1});config_path=root/f"seq-{sequence}.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
        try:
            execution=run_axolotl(config_path,int(os.getenv("QUALIFY_TIMEOUT","3600")))
            if execution.returncode==0:shutil.rmtree(target,ignore_errors=True);return{"resultManifest":f"profile://{sequence}","sequenceLength":sequence,"fingerprint":fingerprint,"diagnostics":{"failed":failures}}
            failures.append({"sequenceLength":sequence,"exitCode":execution.returncode,"diagnostic":safe_diagnostic(execution.stdout) or "no diagnostic output"})
        except subprocess.TimeoutExpired as error:failures.append({"sequenceLength":sequence,"error":"TimeoutExpired","diagnostic":safe_diagnostic(error.stdout)})
        shutil.rmtree(target,ignore_errors=True)
    raise ValueError(f"No library training sequence length of at least 1024 tokens qualified: {json.dumps(failures,separators=(',',':'))}")
