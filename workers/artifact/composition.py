import base64,hashlib,json,os,struct,tempfile
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from canonical_json import canonical

def s3_key(uri,bucket):
    prefix=f"s3://{bucket}/"
    if not str(uri).startswith(prefix):raise ValueError("Composition input is outside the training bucket")
    return str(uri)[len(prefix):]
def verified_manifest(client,bucket,uri,key_path):
    value=json.loads(client.get_object(Bucket=bucket,Key=s3_key(uri,bucket))["Body"].read());signature=value.pop("signature",None)
    private=serialization.load_pem_private_key(Path(key_path).read_bytes(),password=None)
    if not isinstance(private,Ed25519PrivateKey) or not signature:raise ValueError("Adapter manifest has no valid signing identity")
    try:private.public_key().verify(base64.b64decode(signature),canonical(value))
    except Exception as error:raise ValueError("Adapter manifest signature is invalid") from error
    return value
def relative_object(manifest,item):
    marker=f"/adapters/{manifest['artifactId']}/";uri=str(item["uri"])
    if marker not in uri:raise ValueError("Adapter object path is incompatible")
    relative=Path(uri.split(marker,1)[1])
    if relative.is_absolute() or ".." in relative.parts:raise ValueError("Adapter object path is unsafe")
    return relative
def object_bytes(client,bucket,item):
    data=client.get_object(Bucket=bucket,Key=s3_key(item["uri"],bucket))["Body"].read()
    if len(data)!=item["size"] or hashlib.sha256(data).hexdigest()!=item["sha256"]:raise ValueError("Adapter object checksum or size mismatch")
    return data
def canonical_peft_objects(manifest,client,bucket):
    model=None;config=None
    for item in manifest["objects"]:
        relative=relative_object(manifest,item);data=object_bytes(client,bucket,item)
        if len(relative.parts)!=1:continue
        if relative.name=="adapter_model.safetensors":
            if model is not None:raise ValueError(f"Adapter {manifest['artifactId']} contains duplicate canonical PEFT weights")
            model=data
        elif relative.name=="adapter_config.json":
            if config is not None:raise ValueError(f"Adapter {manifest['artifactId']} contains duplicate canonical PEFT configuration")
            config=json.loads(data)
    if model is None or config is None:raise ValueError(f"Adapter {manifest['artifactId']} has no canonical PEFT weights and configuration")
    return model,config
def composition_evaluations(manifests,library):
    language=next(item for item in manifests if item["adapter"].get("modality","language")=="language")
    vision=next(item for item in manifests if item["adapter"].get("modality")=="vision")
    matches=lambda item:[evidence for evidence in item.get("evaluations",[]) if evidence.get("schemaVersion")=="ai.library-likelihood-evaluation/v1"]
    evidence=matches(language)
    if matches(vision):raise ValueError("Vision adapter must not declare language likelihood evidence")
    if len(evidence)>1 or (library.get("promotionEligible") and len(evidence)!=1):raise ValueError("Composed standard adapter requires exactly one language likelihood evaluation")
    if evidence:
        value=evidence[0]
        if value.get("metric")!="completion-negative-log-likelihood" or not all(isinstance(value.get(key),(int,float)) for key in ("baseValue","candidateValue")):raise ValueError("Language likelihood evidence is malformed")
    return evidence
def read_safetensors(data):
    if len(data)<8:raise ValueError("Invalid safetensors object")
    length=struct.unpack("<Q",data[:8])[0];header=json.loads(data[8:8+length]);body=data[8+length:]
    tensors={}
    for name,metadata in header.items():
        if name=="__metadata__":continue
        start,end=metadata["data_offsets"]
        if start<0 or end<start or end>len(body):raise ValueError("Invalid safetensors offsets")
        tensors[name]=(metadata,body[start:end])
    return tensors,header.get("__metadata__",{})
def merge_safetensors(values):
    tensors={};metadata={}
    for data in values:
        current,current_metadata=read_safetensors(data);overlap=set(tensors)&set(current)
        if overlap:raise ValueError(f"Adapter tensor modules overlap: {sorted(overlap)[:5]}")
        tensors.update(current);metadata.update(current_metadata)
    header={"__metadata__":metadata};body=bytearray()
    for name in sorted(tensors):
        descriptor,data=tensors[name];start=len(body);body.extend(data);header[name]={**descriptor,"data_offsets":[start,len(body)]}
    encoded=canonical(header);encoded+=b" "*((8-len(encoded)%8)%8)
    return struct.pack("<Q",len(encoded))+encoded+bytes(body)
def compose(job,client,bucket,key_path,upload,sign):
    value=job["input"];uris=value.get("manifestUris",[])
    if len(uris)!=2:raise ValueError("Exact composition requires one language and one vision manifest")
    manifests=[verified_manifest(client,bucket,uri,key_path) for uri in uris]
    if any(item.get("schemaVersion") not in {"ai.artifact/v2","ai.artifact/v3"} for item in manifests):raise ValueError("Unsupported adapter manifest version")
    first=manifests[0];base=first.get("baseModel");library=first.get("library");rank=first.get("adapter",{}).get("rank");alpha=first.get("adapter",{}).get("alpha")
    for item in manifests:
        adapter=item.get("adapter",{})
        if item.get("baseModel")!=base or item.get("library",{}).get("snapshotId")!=library.get("snapshotId") or adapter.get("rank")!=rank or adapter.get("alpha")!=alpha or adapter.get("format")!="peft":raise ValueError("Adapter base, snapshot, rank, alpha, and format must match")
    modalities={item["adapter"].get("modality","language") for item in manifests}
    if modalities!={"language","vision"}:raise ValueError("Composition requires disjoint language and vision artifacts")
    targets=[target for item in manifests for target in item["adapter"].get("targetModules",[])]
    if len(targets)!=len(set(targets)):raise ValueError("Adapter target declarations overlap")
    parents=[canonical_peft_objects(manifest,client,bucket) for manifest in manifests];models=[item[0] for item in parents]
    config=parents[next(index for index,item in enumerate(manifests) if item["adapter"].get("modality","language")=="language")][1]
    config={**config,"target_modules":"(?:"+")|(?:".join(targets)+")"}
    with tempfile.TemporaryDirectory(prefix="treeai-compose-") as temporary:
        root=Path(temporary);(root/"adapter_model.safetensors").write_bytes(merge_safetensors(models));(root/"adapter_config.json").write_bytes(canonical(config));objects=[]
        for item in sorted(root.iterdir()):objects.append({"uri":upload(item,f"adapters/{job['jobId']}/{item.name}"),"size":item.stat().st_size,"sha256":hashlib.sha256(item.read_bytes()).hexdigest()})
        manifest={"schemaVersion":"ai.artifact/v3","artifactId":job["jobId"],"artifactType":"lora-adapter","createdAt":value.get("createdAt"),"baseModel":base,"trainingConfigDigest":hashlib.sha256("|".join(sorted(item["trainingConfigDigest"] for item in manifests)).encode()).hexdigest(),"datasets":sorted(set(uri for item in manifests for uri in item.get("datasets",[]))),"adapter":{"format":"peft","architecture":"multimodal-causal-lm","purpose":"continual-pretraining","modality":"composed","targetModules":targets,"rank":rank,"alpha":alpha},"library":library,"objects":objects,"evaluations":composition_evaluations(manifests,library),"lineage":{"composition":"exact-disjoint-union","parents":[item["artifactId"] for item in manifests]},"provenance":{"compositionJobId":job["jobId"]},"signingKeyId":os.getenv("SIGNING_KEY_ID","default")}
        target=root/"artifact-manifest.json";target.write_bytes(canonical(sign(manifest)));return{"resultManifest":upload(target,f"manifests/{job['jobId']}.json")}
