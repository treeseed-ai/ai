import hashlib,json,os,re
from pathlib import Path
import boto3
from transformers import AutoTokenizer

def client():return boto3.client("s3",endpoint_url=os.environ["AWS_ENDPOINT_URL"],region_name=os.getenv("AWS_REGION","us-east-1"),aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"])
def key(uri):
    prefix=f"s3://{os.environ['S3_BUCKET']}/"
    if not str(uri).startswith(prefix):raise ValueError("Dataset source is outside the training bucket")
    return str(uri)[len(prefix):]
def content(uri):return client().get_object(Bucket=os.environ["S3_BUCKET"],Key=key(uri))["Body"].read()
def markdown(uri):
    manifest=json.loads(content(uri));objects=manifest.get("objects",[])
    direct=next((item.get("uri") for item in objects if str(item.get("uri","")).endswith("document.md")),None)
    if direct:return content(direct).decode("utf-8")
    prefix=key(uri).rsplit("/",1)[0];listed=client().list_objects_v2(Bucket=os.environ["S3_BUCKET"],Prefix=prefix+"/").get("Contents",[]);item=next((value["Key"] for value in listed if value["Key"].endswith(".md")),None)
    if not item:raise ValueError("Normalized document has no Markdown object")
    return client().get_object(Bucket=os.environ["S3_BUCKET"],Key=item)["Body"].read().decode("utf-8")
def sections(text):
    values=[];heading="Document";buffer=[];fenced=False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):fenced=not fenced
        if not fenced and re.match(r"^#{1,6}\s+",line):
            if "\n".join(buffer).strip():values.append((heading,"\n".join(buffer).strip()))
            heading=re.sub(r"^#{1,6}\s+","",line).strip();buffer=[line]
        else:buffer.append(line)
    if "\n".join(buffer).strip():values.append((heading,"\n".join(buffer).strip()))
    return values
def chunks(tokenizer,text,limit):
    paragraphs=re.split(r"\n{2,}",text);result=[];current=""
    for paragraph in paragraphs:
        candidate=f"{current}\n\n{paragraph}".strip()
        if len(tokenizer.encode(candidate,add_special_tokens=False))<=limit:current=candidate;continue
        if current:result.append(current)
        tokens=tokenizer.encode(paragraph,add_special_tokens=False)
        while len(tokens)>limit:result.append(tokenizer.decode(tokens[:limit],skip_special_tokens=False));tokens=tokens[limit:]
        current=tokenizer.decode(tokens,skip_special_tokens=False) if tokens else ""
    if current:result.append(current)
    return result
def upload(path,key_name,mime):client().upload_file(str(path),os.environ["S3_BUCKET"],key_name,ExtraArgs={"ContentType":mime,"Metadata":{"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}});return f"s3://{os.environ['S3_BUCKET']}/{key_name}"
def prepare(job):
    value=job["input"];documents=value.get("documents",[]);mode=value.get("mode");sequence_len=int(value.get("sequenceLength",2048));model=value["baseModel"];revision=value["baseModelRevision"]
    if mode not in {"smoke","standard"} or not documents:raise ValueError("A smoke or standard snapshot with documents is required")
    tokenizer=AutoTokenizer.from_pretrained(model,revision=revision,trust_remote_code=False);records=[];seen=set();document_tokens={}
    for directory in sorted(value.get("directories",[]),key=lambda item:(item.get("relativePath","").casefold(),item.get("name","").casefold())):
        children=sorted(set(directory.get("childTopics",[])));titles=sorted(set(directory.get("documentTitles",[])))
        outline=f"Library: {value['libraryName']}\nTopic path: {directory.get('relativePath') or 'Root'}\nSection: Library outline\n\nTopic: {directory['name']}\nParent topic: {directory.get('parentPath') or 'Root'}\n"
        if children:outline+=f"Child topics: {', '.join(children)}\n"
        if titles:outline+=f"Documents: {', '.join(titles)}\n"
        outline+=str(tokenizer.eos_token or "");digest=hashlib.sha256(outline.encode()).hexdigest()
        if digest not in seen:seen.add(digest);records.append({"text":outline,"documentRevisionId":None,"digest":digest})
    for document in sorted(documents,key=lambda item:(item["sha256"],item["relativePath"])):
        text=markdown(document["manifestUri"]);document_tokens[document["revisionId"]]=len(tokenizer.encode(text,add_special_tokens=False))
        for heading,section in sections(text):
            header=f"Library: {value['libraryName']}\nTopic path: {document.get('topicPath') or 'Root'}\nDocument: {document['filename']}\nSection: {heading}\n\n"
            for chunk in chunks(tokenizer,section,max(128,sequence_len-len(tokenizer.encode(header,add_special_tokens=False))-1)):
                payload=header+chunk+str(tokenizer.eos_token or "");digest=hashlib.sha256(payload.encode()).hexdigest()
                if digest not in seen:seen.add(digest);records.append({"text":payload,"documentRevisionId":document["revisionId"],"digest":digest})
    total=sum(document_tokens.values());minimum=4096 if mode=="smoke" else 100000
    if total<minimum:raise ValueError(f"{mode} dataset requires at least {minimum} tokens; found {total}")
    if mode=="standard" and len(documents)<3:raise ValueError("Standard datasets require at least three documents")
    held=set()
    if mode=="standard":
        target=max(10000,total//10);accumulated=0
        for document in sorted(documents,key=lambda item:item["sha256"],reverse=True):
            held.add(document["revisionId"]);accumulated+=document_tokens[document["revisionId"]]
            if accumulated>=target:break
    target=Path(os.getenv("OUTPUT_DIR","/artifacts/training"))/job["jobId"];target.mkdir(parents=True,exist_ok=True);train=target/"train.jsonl";evaluation=target/"evaluation.jsonl"
    with train.open("w") as output:
        for item in records:
            if item["documentRevisionId"] not in held:output.write(json.dumps({"text":item["text"]},sort_keys=True)+"\n")
    with evaluation.open("w") as output:
        for item in records:
            if item["documentRevisionId"] in held:output.write(json.dumps({"text":item["text"]},sort_keys=True)+"\n")
    train_uri=upload(train,f"datasets/{job['jobId']}/train.jsonl","application/x-ndjson");evaluation_uri=upload(evaluation,f"datasets/{job['jobId']}/evaluation.jsonl","application/x-ndjson") if evaluation.stat().st_size else None
    manifest={"schemaVersion":"ai.library-dataset/v1","snapshotId":value["snapshotId"],"mode":mode,"format":"completion-jsonl","objects":[{"uri":train_uri,"sha256":hashlib.sha256(train.read_bytes()).hexdigest(),"size":train.stat().st_size}],"evaluationObject":({"uri":evaluation_uri,"sha256":hashlib.sha256(evaluation.read_bytes()).hexdigest(),"size":evaluation.stat().st_size} if evaluation_uri else None),"tokenCount":total-sum(document_tokens[item] for item in held),"evaluationTokenCount":sum(document_tokens[item] for item in held),"sourceDocuments":[{"revisionId":item["revisionId"],"sha256":item["sha256"],"relativePath":item["relativePath"],"heldOut":item["revisionId"] in held} for item in documents],"provenance":{"tokenizer":model,"revision":revision,"sequenceLength":sequence_len}}
    manifest_path=target/"manifest.json";manifest_path.write_text(json.dumps(manifest,sort_keys=True,separators=(",",":")));manifest_uri=upload(manifest_path,f"datasets/{job['jobId']}/manifest.json","application/json")
    return{"resultManifest":manifest_uri,"trainUri":train_uri,"evaluationUri":evaluation_uri,"tokenCount":manifest["tokenCount"],"evaluationTokenCount":manifest["evaluationTokenCount"],"heldOutRevisionIds":sorted(held),"digest":hashlib.sha256(manifest_path.read_bytes()).hexdigest()}
