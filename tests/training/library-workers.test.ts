import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

function python(source:string){
	return JSON.parse(execFileSync('python3',['-c',source],{cwd:process.cwd(),encoding:'utf8'}));
}

describe('library document workers',()=>{
	it('detects supported content by signature and rejects unsafe containers',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/artifact/library.py'));
		const result=python(`import importlib.util,json,sys,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nvalues=[m.detect(b'%PDF-1.7\\n','wrong.txt'),m.detect(b'# Heading\\nBody','guide.md')]\nerrors=[]\nfor data,name in [(b'PK\\x03\\x04not-a-zip','payload.zip'),(b'\\x00binary','notes.txt')]:\n try:m.detect(data,name)\n except ValueError as e:errors.append(str(e))\nprint(json.dumps({'values':values,'errors':errors}))`);
		expect(result.values).toEqual([['application/pdf','marker'],['text/markdown','direct']]);
		expect(result.errors).toEqual(['Malformed document container','Binary document type is unsupported']);
	});

	it('preserves fenced headings and deterministically chunks on paragraph boundaries',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library.py'));
		const result=python(`import importlib.util,json,sys,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\nsys.modules['transformers']=types.SimpleNamespace(AutoTokenizer=None)\ns=importlib.util.spec_from_file_location('library',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nclass T:\n def encode(self,v,add_special_tokens=False):return v.split()\n def decode(self,v,skip_special_tokens=False):return ' '.join(v)\ntext='# One\\nalpha beta\\n\\n\`\`\`md\\n# not a heading\\n\`\`\`\\n\\n# Two\\ngamma delta'\nprint(json.dumps({'sections':m.sections(text),'chunks':m.chunks(T(),'one two\\n\\nthree four',2)}))`);
		expect(result.sections).toHaveLength(2);
		expect(result.sections[0][1]).toContain('# not a heading');
		expect(result.chunks).toEqual(['one two','three four']);
	});

	it('renders only the fixed continual-pretraining QLoRA profile',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,sys,types,tempfile,pathlib\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as d:\n c=m.fixed_config({'sequenceLength':2048},pathlib.Path(d)/'train.jsonl',pathlib.Path(d)/'adapter')\n print(json.dumps(c))`);
		expect(result).toMatchObject({base_model:'Qwen/Qwen3.5-4B',revision:'851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',adapter:'qlora',load_in_4bit:true,lora_r:16,lora_alpha:32,lora_dropout:0.05,micro_batch_size:1,gradient_accumulation_steps:8,learning_rate:0.0001,weight_decay:0.01,warmup_ratio:0.03,seed:42});
		expect(result.datasets[0].type).toBe('completion');expect(result.lora_target_modules).toEqual(['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj']);
	});
	it('invokes the pinned Marker 1.10.2 CLI without unsupported mode flags',()=>{const worker=readFileSync('workers/marker/worker.py','utf8');expect(worker).toContain('["marker_single",str(source),"--output_dir",str(target),"--output_format","markdown"]');expect(worker).not.toContain('"--mode"');});
	it('normalizes stored text and produces a completion-pretraining dataset',()=>{
		const artifact=JSON.stringify(join(process.cwd(),'workers/artifact/library.py')),dataset=JSON.stringify(join(process.cwd(),'workers/axolotl/library.py'));
		const result=python(`import hashlib,importlib.util,json,os,pathlib,sys,tempfile,types
os.environ.update({'AWS_ENDPOINT_URL':'http://s3','AWS_ACCESS_KEY_ID':'id','AWS_SECRET_ACCESS_KEY':'secret','S3_BUCKET':'training'})
objects={}
class Body:
 def __init__(self,value):self.value=value
 def read(self):return self.value
class S3:
 def get_object(self,Bucket,Key):return {'Body':Body(objects[Key])}
 def put_object(self,Bucket,Key,Body,**kwargs):objects[Key]=Body if isinstance(Body,bytes) else Body.read()
 def upload_file(self,path,bucket,key,**kwargs):objects[key]=pathlib.Path(path).read_bytes()
 def list_objects_v2(self,Bucket,Prefix):return {'Contents':[{'Key':key} for key in objects if key.startswith(Prefix)]}
s3=S3();sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:s3)
class T:
 eos_token='<eos>'
 def encode(self,value,add_special_tokens=False):return value.split()
 def decode(self,value,skip_special_tokens=False):return ' '.join(value)
sys.modules['transformers']=types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=lambda *a,**k:T()))
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
a=load('artifact_library',${artifact});d=load('dataset_library',${dataset})
text=('# HTTP Caching\\r\\n'+('Caches preserve protocol semantics and validators across requests. '*1200)).encode();digest=hashlib.sha256(text).hexdigest();objects[f'library-source/{digest}']=text
normalized=a.classify({'input':{'objectUri':f's3://training/library-source/{digest}','sha256':digest,'filename':'http.md','declaredMimeType':'text/markdown'}})
with tempfile.TemporaryDirectory() as target:
 os.environ['OUTPUT_DIR']=target
 prepared=d.prepare({'jobId':'dataset-1','input':{'snapshotId':'snapshot-1','mode':'smoke','libraryName':'Networking','baseModel':'Qwen/Qwen3.5-4B','baseModelRevision':'revision','sequenceLength':1024,'directories':[],'documents':[{'revisionId':'revision-1','sha256':digest,'filename':'http.md','relativePath':'Protocols/http.md','topicPath':'Protocols','manifestUri':normalized['resultManifest']}]}})
 train=objects['datasets/dataset-1/train.jsonl'].decode();manifest=json.loads(objects['datasets/dataset-1/manifest.json'])
 print(json.dumps({'normalized':normalized,'prepared':prepared,'manifest':manifest,'train':train[:250]}))`);
		expect(result.normalized).toMatchObject({state:'ready',processor:'direct',detectedMimeType:'text/markdown'});
		expect(result.prepared.tokenCount).toBeGreaterThanOrEqual(4096);
		expect(result.manifest).toMatchObject({schemaVersion:'ai.library-dataset/v1',mode:'smoke',format:'completion-jsonl',sourceDocuments:[{revisionId:'revision-1',relativePath:'Protocols/http.md',heldOut:false}]});
		expect(result.train).toContain('Library: Networking');expect(result.train).toContain('Topic path: Protocols');expect(result.train).toContain('Document: http.md');
	});
	it('turns a stored PDF into a Marker document bundle without host paths',()=>{
		const marker=JSON.stringify(join(process.cwd(),'workers/marker/worker.py'));
		const result=python(`import hashlib,importlib.util,json,os,pathlib,sys,tempfile,types
os.environ.update({'AWS_ENDPOINT_URL':'http://s3','AWS_ACCESS_KEY_ID':'id','AWS_SECRET_ACCESS_KEY':'secret','S3_BUCKET':'training'})
objects={}
class Body:
 def __init__(self,value):self.value=value
 def read(self):return self.value
class S3:
 def get_object(self,Bucket,Key):return {'Body':Body(objects[Key])}
 def upload_file(self,path,bucket,key):objects[key]=pathlib.Path(path).read_bytes()
s3=S3();sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:s3);sys.modules['common']=types.ModuleType('common');sys.modules['common.server']=types.SimpleNamespace(serve=lambda routes:None)
pdf=b'%PDF-1.7\\nqualification';digest=hashlib.sha256(pdf).hexdigest();objects[f'library-source/{digest}']=pdf
with tempfile.TemporaryDirectory() as target:
 os.environ['OUTPUT_DIR']=target
 spec=importlib.util.spec_from_file_location('marker_worker',${marker});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 def run(command,**kwargs):
  output=pathlib.Path(command[command.index('--output_dir')+1]);output.mkdir(parents=True,exist_ok=True);(output/'document.md').write_text('# PDF Knowledge\\nParsed protocol relationships.');return None
 module.subprocess.run=run
 value=module.process({'jobId':'marker-1','input':{'objectUri':f's3://training/library-source/{digest}','sha256':digest,'filename':'protocol.pdf','declaredMimeType':'application/pdf','detectedMimeType':'application/pdf'}})
 manifest=json.loads(objects['documents/marker-1/manifest.json'])
 print(json.dumps({'value':value,'manifest':manifest,'keys':sorted(objects)}))`);
		expect(result.value).toMatchObject({state:'ready',resultManifest:'s3://training/documents/marker-1/manifest.json'});
		expect(result.manifest).toMatchObject({schemaVersion:'ai.document-bundle/v2',source:{filename:'protocol.pdf',detectedMimeType:'application/pdf'},provenance:{processor:'marker',mode:'balanced'}});
		expect(result.keys).toContain('documents/marker-1/document.md');
	});
});
