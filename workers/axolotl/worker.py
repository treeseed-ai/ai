import json, os, subprocess
from pathlib import Path
from sys import path
path.insert(0,"/app")
from common.server import serve
from library import prepare as prepare_library
from library_train import qualify as qualify_library,train as train_library
from multimodal_train import qualify as qualify_multimodal,train as train_multimodal

OUTPUT=Path(os.getenv("OUTPUT_DIR","/artifacts/training"));OUTPUT.mkdir(parents=True,exist_ok=True)
ALLOWED={"base_model","base_model_config","revision","datasets","dataset_prepared_path","sequence_len","sample_packing","adapter","lora_model_dir","lora_r","lora_alpha","lora_dropout","micro_batch_size","gradient_accumulation_steps","num_epochs","learning_rate","val_set_size","output_dir","load_in_4bit","bf16","tf32","gradient_checkpointing"}
def train(job):
    config=job["input"].get("config",{});unknown=set(config)-ALLOWED
    if unknown: raise ValueError(f"Unsupported Axolotl fields: {sorted(unknown)}")
    if config.get("adapter","qlora")!="qlora" or config.get("load_in_4bit",True) is not True: raise ValueError("V1 supports QLoRA only")
    target=OUTPUT/job["jobId"];target.mkdir(exist_ok=True);manifest=target/"result.json"
    if manifest.exists(): return{"resultManifest":f"file://{manifest}"}
    revision=job["input"].get("baseModelRevision")
    if not revision or (config.get("revision") and config["revision"]!=revision): raise ValueError("An immutable matching baseModelRevision is required")
    resolved={**config,"revision":revision,"adapter":"qlora","load_in_4bit":True,"output_dir":str(target)}
    config_path=target/"axolotl.json";config_path.write_text(json.dumps(resolved,sort_keys=True))
    subprocess.run(["accelerate","launch","-m","axolotl.cli.train",str(config_path)],check=True,timeout=int(os.getenv("TRAIN_TIMEOUT","86400")))
    manifest.write_text(json.dumps({"schemaVersion":"ai.training-result/v1","baseModel":resolved.get("base_model"),"adapterPath":str(target),"config":str(config_path)},sort_keys=True));return{"resultManifest":f"file://{manifest}"}
serve({"/prepare-library-dataset":prepare_library,"/qualify-library":qualify_library,"/train-library":train_library,"/qualify-library-multimodal":qualify_multimodal,"/train-library-multimodal":train_multimodal,"/train":train})
