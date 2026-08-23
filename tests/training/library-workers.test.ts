import {execFileSync} from 'node:child_process';
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
});
