import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

function python(source:string){return JSON.parse(execFileSync('python3',['-c',source],{cwd:process.cwd(),encoding:'utf8'}));}

describe('multimodal library processing',()=>{
	it('retains only checksum-bound source-authored image evidence',()=>{
		const worker=JSON.stringify(join(process.cwd(),'workers/marker/worker.py'));
		const result=python(`import importlib.util,json,os,pathlib,sys,tempfile,types
os.environ['OUTPUT_DIR']=tempfile.mkdtemp(prefix='treeai-marker-test-')
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None);sys.modules['common']=types.ModuleType('common');sys.modules['common.server']=types.SimpleNamespace(serve=lambda routes:None)
spec=importlib.util.spec_from_file_location('marker',${worker});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 target=pathlib.Path(root);structured=target/'structured';structured.mkdir();images=target/'images';images.mkdir();(images/'figure.png').write_bytes(b'\\x89PNG\\r\\n\\x1a\\nsource-authored-image')
 (structured/'document.json').write_text(json.dumps({'type':'Page','page':3,'children':[{'type':'SectionHeader','text':'Engine assembly'},{'type':'Figure','image':'figure.png'},{'type':'Text','text':'The source explains the labeled engine assembly and airflow path.'}]}))
 blocks,evidence=module.authored_image_evidence(structured,target);print(json.dumps({'blocks':blocks,'evidence':evidence}))`);
		expect(result.blocks).toHaveLength(4);expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]).toMatchObject({imagePath:'images/figure.png',page:3,section:'Engine assembly',eligible:true,mimeType:'image/png'});
		expect(result.evidence[0].authoredContext).toContain('source explains');
	});

	it('correlates real Marker Markdown image references with authored context',()=>{
		const worker=JSON.stringify(join(process.cwd(),'workers/marker/worker.py'));
		const result=python(`import importlib.util,json,os,pathlib,sys,tempfile,types
os.environ['OUTPUT_DIR']=tempfile.mkdtemp(prefix='treeai-marker-test-')
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None);sys.modules['common']=types.ModuleType('common');sys.modules['common.server']=types.SimpleNamespace(serve=lambda routes:None)
spec=importlib.util.spec_from_file_location('marker',${worker});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 target=pathlib.Path(root);structured=target/'structured';structured.mkdir();markdown=target/'markdown';markdown.mkdir();images=target/'images';images.mkdir()
 (images/'_page_7_Figure_3.jpeg').write_bytes(b'\\xff\\xd8\\xffsource-authored-image')
 (structured/'document.json').write_text(json.dumps({'type':'Page','page':7,'children':[]}))
 (markdown/'document.md').write_text('## Thermal protection system\\n\\nThe report compares measured temperatures across the reusable heat-shield tiles.\\n\\n![](_page_7_Figure_3.jpeg)\\n\\nFigure 3. Measured tile temperatures during atmospheric entry.\\n')
 blocks,evidence=module.authored_image_evidence(structured,target);print(json.dumps({'blocks':blocks,'evidence':evidence}))`);
		expect(result.evidence).toHaveLength(1);
		expect(result.evidence[0]).toMatchObject({imagePath:'images/_page_7_Figure_3.jpeg',section:'Thermal protection system',eligible:true,mimeType:'image/jpeg'});
		expect(result.evidence[0].authoredContext).toContain('Figure 3');
	});

	it('renders a bounded Qwen 3.5 vision QLoRA config without sample packing',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/multimodal_train.py'));
		const result=python(`import contextlib,importlib.util,json,pathlib,sys,tempfile,types
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)
stub=types.ModuleType('library_train');stub.BASE_MODEL='Qwen/Qwen3.5-4B';stub.BASE_REVISION='851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a';stub.fixed_steps=lambda c,*a:c;stub.job_guard=lambda *a:contextlib.nullcontext();stub.run_axolotl=lambda *a:None;stub.safe_diagnostic=str;sys.modules['library_train']=stub
spec=importlib.util.spec_from_file_location('multimodal',${modulePath});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 config=module.fixed_config({'sequenceLength':2048,'maxPixels':262144},pathlib.Path(root)/'train.jsonl',pathlib.Path(root)/'adapter');print(json.dumps(config))`);
		expect(result).toMatchObject({base_model:'Qwen/Qwen3.5-4B',processor_type:'AutoProcessor',chat_template:'qwen3_5',skip_prepare_dataset:true,remove_unused_columns:false,sample_packing:false,image_size:512,adapter:'qlora',load_in_4bit:true,lora_r:16,lora_alpha:32});
		expect(result.datasets).toEqual([expect.objectContaining({type:'chat_template'})]);
		expect(result.lora_target_modules).toContain('model\\.visual');
		const target=new RegExp(`^(?:${result.lora_target_modules})$`,'u');
		expect(target.test('model.visual.blocks.0.attn.qkv')).toBe(true);
		expect(target.test('model.visual.blocks.7.attn.proj')).toBe(true);
		expect(target.test('model.visual.blocks.3.mlp.linear_fc1')).toBe(true);
		expect(target.test('model.visual.merger.linear_fc2')).toBe(true);
		expect(target.test('model.visual.blocks.0')).toBe(false);
		expect(target.test('model.language_model.layers.0.self_attn.q_proj')).toBe(false);
	});

	it('resolves only verified worker-local image paths without mutating source JSONL',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/axolotl/multimodal_train.py'));
		const result=python(`import contextlib,importlib.util,json,pathlib,sys,tempfile,types
sys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)
stub=types.ModuleType('library_train');stub.BASE_MODEL='model';stub.BASE_REVISION='revision';stub.fixed_steps=lambda c,*a:c;stub.job_guard=lambda *a:contextlib.nullcontext();stub.run_axolotl=lambda *a:None;stub.safe_diagnostic=str;sys.modules['library_train']=stub
spec=importlib.util.spec_from_file_location('multimodal',${modulePath});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as root:
 source=(json.dumps({'messages':[{'role':'user','content':[{'type':'image','path':'images/figure.png'},{'type':'text','text':'Explain'}]},{'role':'assistant','content':[{'type':'text','text':'Grounded'}]}]})+'\\n').encode();original=bytes(source);image=pathlib.Path(root)/'images/figure.png';image.parent.mkdir();image.write_bytes(b'png')
 resolved=module.resolve_local_images(source,{'images/figure.png':image.resolve()});record=json.loads(resolved);print(json.dumps({'path':record['messages'][0]['content'][0]['path'],'sourceUnchanged':source==original,'absolute':pathlib.Path(record['messages'][0]['content'][0]['path']).is_absolute()}))`);
		expect(result).toMatchObject({sourceUnchanged:true,absolute:true});expect(result.path).toContain('/images/figure.png');
	});

	it('adds multimodal state without changing existing library rows',()=>{
		const migration=execFileSync('bash',['-lc','cat migrations/training/005_multimodal_libraries.sql'],{cwd:process.cwd(),encoding:'utf8'});
		expect(migration).toContain('ADD COLUMN IF NOT EXISTS multimodal_train_uri');
		expect(migration).toContain('library_multimodal_training_profiles');
		expect(migration).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/u);
	});
});
