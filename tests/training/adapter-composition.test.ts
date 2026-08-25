import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

function python(source:string){return JSON.parse(execFileSync('python3',['-c',source],{cwd:process.cwd(),encoding:'utf8'}));}

describe('exact adapter composition',()=>{
	it('forms a deterministic exact union of disjoint safetensor entries',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/artifact/composition.py'));
		const result=python(`import importlib.util,json,struct,sys,types
sys.modules['cryptography']=types.ModuleType('cryptography');sys.modules['cryptography.hazmat']=types.ModuleType('hazmat');sys.modules['cryptography.hazmat.primitives']=types.SimpleNamespace(serialization=None);sys.modules['cryptography.hazmat.primitives.asymmetric']=types.ModuleType('asymmetric');sys.modules['cryptography.hazmat.primitives.asymmetric.ed25519']=types.SimpleNamespace(Ed25519PrivateKey=object)
spec=importlib.util.spec_from_file_location('composition',${modulePath});module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def tensor(name,data):
 header=json.dumps({name:{'dtype':'U8','shape':[len(data)],'data_offsets':[0,len(data)]}},sort_keys=True,separators=(',',':')).encode();header+=b' '*((8-len(header)%8)%8);return struct.pack('<Q',len(header))+header+data
merged=module.merge_safetensors([tensor('model.language.weight',b'abc'),tensor('model.visual.weight',b'defg')]);values,_=module.read_safetensors(merged);print(json.dumps({'keys':sorted(values),'values':{key:value[1].decode() for key,value in values.items()},'digest':__import__('hashlib').sha256(merged).hexdigest()}))`);
		expect(result.keys).toEqual(['model.language.weight','model.visual.weight']);
		expect(result.values).toEqual({'model.language.weight':'abc','model.visual.weight':'defg'});
		expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
	});

	it('rejects overlapping tensor modules instead of applying a merge heuristic',()=>{
		const source=readFileSync('workers/artifact/composition.py','utf8');
		expect(source).toContain('Adapter tensor modules overlap');
		expect(source).toContain('exact-disjoint-union');
		expect(source).not.toMatch(/\b(?:average|weighted|ties|dare)\b/iu);
	});

	it('keeps multimodal vLLM disabled until a qualified profile enables it',()=>{
		const entrypoint=readFileSync('containers/inference/vllm-entrypoint.sh','utf8'),compose=readFileSync('deploy/inference/compose.yml','utf8');
		expect(entrypoint).toContain('TREEAI_MULTIMODAL_LORA_ENABLED:-false');
		expect(entrypoint).toContain('--enable-tower-connector-lora');
		expect(entrypoint).toContain('--language-model-only');
		expect(compose).toContain('TREEAI_MULTIMODAL_LORA_ENABLED:-false');
	});

	it('authorizes runtime LoRA updates only on the private vLLM service',()=>{
		for(const path of ['deploy/inference/compose.yml','deploy/inference/factory.override.yml','deploy/component/compose.template.yml'])expect(readFileSync(path,'utf8')).toContain('VLLM_ALLOW_RUNTIME_LORA_UPDATING');
		for(const path of ['deploy/inference/compose.yml','deploy/inference/factory.override.yml'])expect(readFileSync(path,'utf8')).not.toMatch(/8000:8000/u);
	});
});
