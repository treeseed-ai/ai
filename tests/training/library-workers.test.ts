import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

function python(source:string){
	const preamble=`import os,tempfile\nos.environ.setdefault('ARTIFACT_BACKEND','filesystem')\nos.environ.setdefault('ARTIFACT_ROOT',tempfile.mkdtemp(prefix='treeai-test-artifacts-'))\nos.environ.setdefault('ARTIFACT_STORE_ID','training')\nos.environ.setdefault('ARTIFACT_LEGACY_BUCKETS','ai-training,training')\n`;
	return JSON.parse(execFileSync('python3',['-c',preamble+source],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,PYTHONPATH:join(process.cwd(),'workers')}}));
}

describe('library document workers',()=>{
	it('uses the shared artifact repository instead of direct S3 calls',()=>{for(const file of['workers/marker/worker.py','workers/axolotl/library.py','workers/axolotl/library_train.py','workers/axolotl/multimodal_train.py','workers/artifact/library.py','workers/artifact/worker.py','workers/artifact/composition.py']){const source=readFileSync(file,'utf8');expect(source,file).not.toMatch(/\b(?:get_object|put_object|upload_file|list_objects_v2|S3_BUCKET|AWS_ENDPOINT_URL)\b/u);}});
	it('keeps bounded Axolotl operations on one transport-unlimited cancellable request',()=>{const source=readFileSync('packages/training-manager/src/main.ts','utf8'),manifest=readFileSync('packages/training-manager/package.json','utf8');expect(source).toContain('new Agent({headersTimeout:0,bodyTimeout:0})');expect(source).toContain('dispatcher:axolotlWorkerDispatcher');expect(source).toContain("await cancelAxolotl(axolotl,job.id)");expect(manifest).toContain('"undici": "8.10.0"');});
	it('admits one Axolotl subprocess per job and terminates its process group',()=>{const source=readFileSync('workers/axolotl/library_train.py','utf8'),server=readFileSync('workers/common/server.py','utf8');expect(source).toContain('fcntl.LOCK_EX|fcntl.LOCK_NB');expect(source).toContain('start_new_session=True');expect(source).toContain('os.killpg(process.pid,signal.SIGTERM)');expect(source).toContain('_PROCESSES[job_id]=process');expect(server).toContain('getattr(error,"status_code",500)');});
	it('reports only bounded structured Axolotl progress',()=>{const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py')),result=python(`import importlib.util,json,sys,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps({'tqdm':m.progress_from_output(' 38%|### | 9/24 [01:00<02:00]'),'plain':m.progress_from_output('step 7 / 8'),'invalid':m.progress_from_output('100%|### | 9/8 secret')}))`);expect(result).toEqual({tqdm:{progress:.375,currentStep:9,totalSteps:24,percent:38},plain:null,invalid:null});const source=readFileSync('workers/axolotl/library_train.py','utf8'),worker=readFileSync('workers/axolotl/worker.py','utf8'),manager=readFileSync('packages/training-manager/src/main.ts','utf8');expect(source).toContain('len(_STATUS_ORDER)>=128');expect(worker).toContain('"/status":lambda request:execution_status');expect(manager).toContain("axolotlCallWithProgress(axolotl,'train-library-multimodal'");expect(manager).not.toContain('status.diagnostic');});
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
		const result=python(`import importlib.util,json,sys,types,tempfile,pathlib\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as d:\n c=m.fixed_config({'sequenceLength':2048},pathlib.Path(d)/'train.jsonl',pathlib.Path(d)/'adapter');q=m.fixed_steps(dict(c),1,1)\n print(json.dumps({'standard':c,'qualification':q}))`);
		expect(result.standard).toMatchObject({base_model:'Qwen/Qwen3.5-4B',revision:'851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a',adapter:'qlora',load_in_4bit:true,sample_packing:false,lora_r:16,lora_alpha:32,lora_dropout:0.05,micro_batch_size:1,gradient_accumulation_steps:8,learning_rate:0.0001,weight_decay:0.01,warmup_ratio:0.03,num_epochs:1,seed:42});
		expect(result.standard.datasets[0].type).toBe('completion');expect(result.standard.lora_target_modules).toContain('model\\.language_model');expect(result.qualification).toMatchObject({max_steps:1,save_steps:1});expect(result.qualification).not.toHaveProperty('num_epochs');
	});
	it('builds fixed base and adapter held-out evaluation profiles',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,pathlib,sys,tempfile,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nwith tempfile.TemporaryDirectory() as d:\n root=pathlib.Path(d);training=m.fixed_config({'sequenceLength':3072},root/'train.jsonl',root/'adapter');base=m.evaluation_config(training,root/'heldout.jsonl',root/'probe.jsonl',root/'base');candidate=m.evaluation_config(training,root/'heldout.jsonl',root/'probe.jsonl',root/'candidate',root/'adapter');print(json.dumps({'base':base,'candidate':candidate}))`);
		expect(result.base).toMatchObject({base_model:'Qwen/Qwen3.5-4B',sequence_len:3072,adapter:'qlora',load_in_4bit:true,lora_r:16,eval_batch_size:1,shuffle_merged_datasets:false});
		expect(result.base).toMatchObject({adapter:'qlora',load_in_4bit:true,learning_rate:0.0001});expect(result.base).not.toHaveProperty('lora_model_dir');expect(result.base.test_datasets[0]).toMatchObject({type:'completion'});
		expect(result.candidate).toMatchObject({adapter:'qlora',load_in_4bit:true,learning_rate:0.0001,lora_model_dir:expect.stringContaining('/adapter')});
	});
	it('falls through an unsafe sustained sequence probe and fingerprints the allocator policy',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,os,pathlib,sys,tempfile,types
s=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 os.environ.update({'OUTPUT_DIR':root,'TREEAI_IMAGE_ID':'image'});m.REPOSITORY.put_bytes('datasets/train.jsonl',b'{"text":"qualification sample"}\\n')
 m.subprocess.check_output=lambda *a,**k:'GPU-test, 595.84'
 trials=[]
 def run(path,timeout,*_):
  config=json.loads(pathlib.Path(path).read_text());trials.append({'sequence':config['sequence_len'],'steps':config['max_steps']});return types.SimpleNamespace(returncode=1 if config['sequence_len']==4096 else 0,stdout='CUDA out of memory')
 m.run_axolotl=run
 value=m.qualify({'jobId':'qualification-test','input':{'trainUri':'artifact://training/datasets/train.jsonl'}})
 print(json.dumps({'value':value,'trials':trials,'steps':m.QUALIFICATION_STEPS,'policy':m.ALLOCATOR_POLICY}))`);
		expect(result.value).toMatchObject({resultManifest:'profile://3072',sequenceLength:3072,diagnostics:{failed:[{sequenceLength:4096,exitCode:1}]}});
		expect(result.trials).toEqual([{sequence:4096,steps:8},{sequence:3072,steps:8}]);expect(result.steps).toBe(8);expect(result.policy).toBe('expandable_segments:True');
	});
	it('rejects a concurrent duplicate worker execution lock',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,pathlib,sys,tempfile,types
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)
s=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d);blocked=False
 with m.job_guard(root):
  try:
   with m.job_guard(root):pass
  except m.JobAlreadyRunning as error:blocked=error.status_code==409
 print(json.dumps({'blocked':blocked}))`);
		expect(result).toEqual({blocked:true});
	});
	it('cancels the exact registered Axolotl process group',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,subprocess,sys,time,types
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)
s=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
process=subprocess.Popen(['sleep','60'],start_new_session=True);m._PROCESSES['job-1']=process
cancelled=m.cancel_axolotl('job-1');print(json.dumps({'cancelled':cancelled,'terminal':process.poll() is not None,'unknown':m.cancel_axolotl('missing')}))`);
		expect(result).toEqual({cancelled:true,terminal:true,unknown:false});
	});
	it('bounds and redacts Axolotl diagnostics',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/library_train.py'));
		const result=python(`import importlib.util,json,sys,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\ns=importlib.util.spec_from_file_location('library_train',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nvalue='prefix '+('x'*2500)+' api_key=abcdefghijklmnop /home/adrian/private/config.json /run/secrets/signing-key'\nprint(json.dumps({'value':m.safe_diagnostic(value)}))`);
		expect(result.value.length).toBeLessThanOrEqual(2000);expect(result.value).toContain('[REDACTED]');expect(result.value).toContain('[REDACTED_PATH]');expect(result.value).not.toContain('abcdefghijklmnop');expect(result.value).not.toContain('/home/adrian');expect(result.value).not.toContain('/run/secrets');
	});
	it('renders Markdown and structured JSON from one persistent Marker document graph',()=>{const worker=readFileSync('workers/marker/worker.py','utf8'),compose=readFileSync('deploy/training/compose.yml','utf8'),dockerfile=readFileSync('containers/training/marker.Dockerfile','utf8');expect(worker).toContain('document=converter.build_document(str(source))');expect(worker).toContain('MarkdownRenderer)(document)');expect(worker).toContain('JSONRenderer)(document)');expect(worker).toContain('_CONVERTER=converter_cls');expect(worker).not.toContain('marker_single');expect(worker).toContain('[-12000:]');expect(worker).toContain('SECRET.sub("[REDACTED]"');expect(compose).toContain('HF_HOME: /models/huggingface');expect(compose).toContain('FONT_PATH: /models/cache/fonts/GoNotoCurrent-Regular.ttf');expect(compose).toContain('["training-artifacts:/artifacts", "training-models:/models"]');expect(dockerfile).toContain('chown -R worker /inputs /artifacts /models');});
	it('installs and exercises the native WeasyPrint runtime required by Marker HTML conversion',()=>{const dockerfile=readFileSync('containers/training/marker.Dockerfile','utf8');for(const dependency of ['libglib2.0-0t64','libcairo2','libpango-1.0-0','libpangoft2-1.0-0','libgdk-pixbuf-2.0-0','shared-mime-info'])expect(dockerfile).toContain(dependency);expect(dockerfile).toContain('from weasyprint import HTML');expect(dockerfile).toContain("HTML(string='<h1>TreeAI Marker HTML qualification</h1><p>Native runtime ready.</p>').write_pdf(target)");});
	it('gives non-root Axolotl its compiler headers, Qwen 3.5 processor support, and persistent writable runtime paths',()=>{const compose=readFileSync('deploy/training/compose.yml','utf8'),dockerfile=readFileSync('containers/training/axolotl.Dockerfile','utf8'),requirements=readFileSync('workers/axolotl/requirements.lock','utf8');expect(compose).toContain('HF_HOME: /models/huggingface');expect(compose).toContain('XDG_CACHE_HOME: /models/cache');expect(compose).toContain('TORCH_HOME: /models/torch');expect(compose).toContain('TRITON_CACHE_DIR: /models/triton');expect(dockerfile).toContain('python3 python3-dev python3-pip');expect(dockerfile).toContain('/models/triton');expect(dockerfile).toContain('chown -R worker /artifacts /models');expect(dockerfile).toMatch(/USER worker\s+WORKDIR \/artifacts\/training\s+CMD \["python3","\/app\/axolotl-worker\/worker.py"\]/u);expect(requirements).toContain('axolotl==0.18.0');expect(requirements).toContain('transformers==5.14.1');expect(requirements).toContain('torchvision==0.26.0');});
	it('normalizes stored text and produces a completion-pretraining dataset',()=>{
		const artifact=JSON.stringify(join(process.cwd(),'workers/artifact/library.py')),dataset=JSON.stringify(join(process.cwd(),'workers/axolotl/library.py'));
		const result=python(`import hashlib,importlib.util,json,os,pathlib,sys,tempfile,types
class T:
 eos_token='<eos>'
 def encode(self,value,add_special_tokens=False):return value.split()
 def decode(self,value,skip_special_tokens=False):return ' '.join(value)
sys.modules['transformers']=types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=lambda *a,**k:T()))
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
a=load('artifact_library',${artifact});d=load('dataset_library',${dataset})
text=('# HTTP Caching\\r\\n'+('Caches preserve protocol semantics and validators across requests. '*1200)).encode();digest=hashlib.sha256(text).hexdigest();a.REPOSITORY.put_bytes(f'library-source/{digest}',text)
normalized=a.classify({'input':{'objectUri':f'artifact://training/library-source/{digest}','sha256':digest,'filename':'http.md','declaredMimeType':'text/markdown'}})
with tempfile.TemporaryDirectory() as target:
 os.environ['OUTPUT_DIR']=target
 prepared=d.prepare({'jobId':'dataset-1','input':{'snapshotId':'snapshot-1','mode':'smoke','libraryName':'Networking','baseModel':'Qwen/Qwen3.5-4B','baseModelRevision':'revision','sequenceLength':1024,'directories':[],'documents':[{'revisionId':'revision-1','sha256':digest,'filename':'http.md','relativePath':'Protocols/http.md','topicPath':'Protocols','manifestUri':normalized['resultManifest']}]}})
 train=d.REPOSITORY.bytes('datasets/dataset-1/train.jsonl').decode();manifest=json.loads(d.REPOSITORY.bytes('datasets/dataset-1/manifest.json'))
 print(json.dumps({'normalized':normalized,'prepared':prepared,'manifest':manifest,'train':train[:250]}))`);
		expect(result.normalized).toMatchObject({state:'ready',processor:'direct',detectedMimeType:'text/markdown'});
		expect(result.prepared.tokenCount).toBeGreaterThanOrEqual(4096);
		expect(result.manifest).toMatchObject({schemaVersion:'ai.library-dataset/v2',mode:'smoke',formats:['completion-jsonl'],sourceDocuments:[{revisionId:'revision-1',relativePath:'Protocols/http.md',heldOut:false}]});
		expect(result.train).toContain('Library: Networking');expect(result.train).toContain('Topic path: Protocols');expect(result.train).toContain('Document: http.md');
	});
	it('turns a stored PDF into a Marker document bundle without host paths',()=>{
		const marker=JSON.stringify(join(process.cwd(),'workers/marker/worker.py'));
		const result=python(`import hashlib,importlib.util,json,os,pathlib,sys,tempfile,types
sys.modules['common.server']=types.SimpleNamespace(serve=lambda routes:None)
pdf=b'%PDF-1.7\\nqualification';digest=hashlib.sha256(pdf).hexdigest()
with tempfile.TemporaryDirectory() as target:
 os.environ['OUTPUT_DIR']=target
 spec=importlib.util.spec_from_file_location('marker_worker',${marker});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.REPOSITORY.put_bytes(f'library-source/{digest}',pdf)
 calls=[]
 def convert(source,markdown,structured,job_id):
  calls.append(job_id);markdown.mkdir(parents=True,exist_ok=True);structured.mkdir(parents=True,exist_ok=True)
  (markdown/'document.md').write_text('# PDF Knowledge\\nParsed protocol relationships.')
  (structured/'document.json').write_text(json.dumps({'type':'Page','page':1,'children':[{'type':'SectionHeader','text':'Protocol diagram'},{'type':'Text','text':'Authored explanation of the protocol relationship.'}]}))
 module.convert_document=convert
 value=module.process({'jobId':'marker-1','input':{'objectUri':f'artifact://training/library-source/{digest}','sha256':digest,'filename':'protocol.pdf','declaredMimeType':'application/pdf','detectedMimeType':'application/pdf'}})
 manifest=json.loads(module.REPOSITORY.bytes('documents/marker-1/manifest.json'));keys=[item['key'] for item in module.REPOSITORY.list()]
 print(json.dumps({'value':value,'manifest':manifest,'keys':sorted(keys),'calls':calls}))`);
		expect(result.value).toMatchObject({state:'ready',resultManifest:'artifact://training/documents/marker-1/manifest.json'});
		expect(result.calls).toEqual(['marker-1']);
		expect(result.manifest).toMatchObject({schemaVersion:'ai.document-bundle/v3',source:{filename:'protocol.pdf',detectedMimeType:'application/pdf'},provenance:{processor:'marker',mode:'balanced',outputs:['markdown','json']}});
		expect(result.keys).toContain('documents/marker-1/markdown/document.md');
	});
});
