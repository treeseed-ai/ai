import hashlib,json,os,re,shutil,subprocess
from pathlib import Path
import boto3
from library_train import BASE_MODEL,BASE_REVISION,fixed_steps,run_axolotl,safe_diagnostic

VISION_TARGET=r"model\.visual\.(blocks|merger)\..*"
SEQUENCES=(4096,3072,2048,1024)
PIXEL_TIERS=(786432,524288,262144)

def client():return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix):raise ValueError("Multimodal dataset is outside the training bucket")
    return str(uri)[len(prefix):]
def download_dataset(value,root):
    manifest=json.loads(client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(value["datasetManifest"]))["Body"].read())
    if manifest.get("schemaVersion")!="ai.library-dataset/v2":raise ValueError("Multimodal training requires ai.library-dataset/v2")
    multi=manifest.get("multimodal",{});source=multi.get("trainObject")
    if not source:raise ValueError("Dataset contains no qualified source-authored image examples")
    dataset_data=client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(source["uri"]))["Body"].read()
    if hashlib.sha256(dataset_data).hexdigest()!=source["sha256"] or len(dataset_data)!=source["size"]:raise ValueError("Multimodal dataset checksum or size mismatch")
    dataset=root/"multimodal-train.jsonl";dataset.write_bytes(dataset_data)
    for item in multi.get("imageObjects",[]):
        relative=Path(str(item.get("relativePath","")))
        if relative.is_absolute() or ".." in relative.parts:raise ValueError("Unsafe dataset image path")
        destination=root/relative;destination.parent.mkdir(parents=True,exist_ok=True)
        data=client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(item["uri"]))["Body"].read()
        if hashlib.sha256(data).hexdigest()!=item["sha256"] or len(data)!=item["size"]:raise ValueError("Multimodal dataset image checksum or size mismatch")
        destination.write_bytes(data)
    return dataset,manifest
def fixed_config(value,dataset,target):
    sequence=int(value["sequenceLength"]);pixels=int(value["maxPixels"])
    if sequence not in SEQUENCES or pixels not in PIXEL_TIERS:raise ValueError("Multimodal training profile is not qualified")
    image_size=max(256,int(pixels**0.5))
    return{"base_model":BASE_MODEL,"revision":BASE_REVISION,"processor_type":"AutoProcessor","chat_template":"qwen3_5","datasets":[{"path":str(dataset),"type":"chat_template"}],"sequence_len":sequence,"skip_prepare_dataset":True,"remove_unused_columns":False,"sample_packing":False,"image_size":image_size,"image_resize_algorithm":"bilinear","adapter":"qlora","load_in_4bit":True,"lora_r":16,"lora_alpha":32,"lora_dropout":0.05,"lora_target_modules":VISION_TARGET,"bf16":True,"gradient_checkpointing":True,"micro_batch_size":1,"gradient_accumulation_steps":8,"learning_rate":0.0001,"weight_decay":0.01,"warmup_ratio":0.03,"num_epochs":1,"seed":42,"output_dir":str(target),"save_steps":int(value.get("saveSteps",25)),"evals_per_epoch":1}
def train(job):
    value=job["input"]
    if value.get("baseModel")!=BASE_MODEL or value.get("baseModelRevision")!=BASE_REVISION:raise ValueError("Multimodal training requires the immutable qualified base revision")
    root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/job["jobId"];root.mkdir(parents=True,exist_ok=True);result=root/"multimodal-result.json"
    if result.exists():return{"resultManifest":f"file://{result}","configurationDigest":json.loads(result.read_text())["configDigest"]}
    dataset,manifest=download_dataset(value,root);target=root/"vision-adapter";config=fixed_config(value,dataset,target)
    if value.get("mode")=="smoke":fixed_steps(config,16,8)
    config_path=root/"multimodal-axolotl.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
    execution=run_axolotl(config_path,int(os.getenv("TRAIN_TIMEOUT","86400")))
    if execution.returncode:raise RuntimeError(f"Axolotl multimodal training exited {execution.returncode}: {safe_diagnostic(execution.stdout,12000) or 'no diagnostic output'}")
    payload={"schemaVersion":"ai.library-training-result/v2","modality":"vision","baseModel":BASE_MODEL,"baseModelRevision":BASE_REVISION,"adapterPath":str(target),"config":str(config_path),"configDigest":hashlib.sha256(config_path.read_bytes()).hexdigest(),"mode":value["mode"],"libraryId":value["libraryId"],"librarySlug":value["librarySlug"],"snapshotId":value["snapshotId"],"datasetManifest":value["datasetManifest"],"datasetDigest":hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest(),"targetModules":[VISION_TARGET],"rank":16,"alpha":32}
    result.write_text(json.dumps(payload,sort_keys=True,separators=(",",":")));return{"resultManifest":f"file://{result}","configurationDigest":payload["configDigest"]}
def qualify(job):
    value=job["input"];identity=subprocess.check_output(["nvidia-smi","--query-gpu=uuid,driver_version","--format=csv,noheader"],text=True).strip();fingerprint=hashlib.sha256(f"{identity}|{os.getenv('TREEAI_IMAGE_ID','unknown')}|{BASE_REVISION}|vision-r16|mb1|ga8".encode()).hexdigest();root=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/f"multimodal-qualification-{fingerprint}";root.mkdir(parents=True,exist_ok=True);dataset,_=download_dataset(value,root);failures=[]
    for sequence in SEQUENCES:
        for pixels in PIXEL_TIERS:
            target=root/f"seq-{sequence}-px-{pixels}";config=fixed_steps(fixed_config({"sequenceLength":sequence,"maxPixels":pixels},dataset,target),1,1);config_path=root/f"seq-{sequence}-px-{pixels}.json";config_path.write_text(json.dumps(config,sort_keys=True,separators=(",",":")))
            try:
                execution=run_axolotl(config_path,int(os.getenv("QUALIFY_TIMEOUT","3600")))
                if execution.returncode==0:shutil.rmtree(target,ignore_errors=True);return{"resultManifest":f"multimodal-profile://{sequence}/{pixels}","sequenceLength":sequence,"maxPixels":pixels,"fingerprint":fingerprint,"diagnostics":{"failed":failures}}
                failures.append({"sequenceLength":sequence,"maxPixels":pixels,"exitCode":execution.returncode,"diagnostic":safe_diagnostic(execution.stdout)})
            except subprocess.TimeoutExpired as error:failures.append({"sequenceLength":sequence,"maxPixels":pixels,"error":"TimeoutExpired","diagnostic":safe_diagnostic(error.stdout)})
            shutil.rmtree(target,ignore_errors=True)
    raise ValueError(f"No conservative multimodal profile qualified: {json.dumps(failures,separators=(',',':'))}")
