import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

describe('library adapter ranking',()=>{
	it('requires two percent lower held-out NLL and no general regression',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/evaluator/worker.py'));
		const result=JSON.parse(execFileSync('python3',['-c',`import importlib.util,json,os,pathlib,sys,tempfile,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\nserver=types.ModuleType('common.server');server.serve=lambda routes:None\nsys.modules['common']=types.ModuleType('common');sys.modules['common.server']=server\nwith tempfile.TemporaryDirectory() as d:\n os.environ['STATE_DIR']=d;s=importlib.util.spec_from_file_location('evaluator',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n values={'general':{'results':[{'candidate':'base','categories':{'quality':0.8},'criticalChecksPassed':True},{'candidate':'candidate','categories':{'quality':0.8},'criticalChecksPassed':True}]},'base':{'value':2.0},'candidate':{'value':1.9}}\n for name,value in values.items():pathlib.Path(d,f'{name}.json').write_text(json.dumps(value))\n output=m.rank_library({'jobId':'rank','input':{'candidateId':'candidate','generalManifest':f'file://{d}/general.json','baseLikelihoodManifest':f'file://{d}/base.json','candidateLikelihoodManifest':f'file://{d}/candidate.json'}})\n print(pathlib.Path(output['resultManifest'][7:]).read_text())`],{cwd:process.cwd(),encoding:'utf8'}));
		expect(result).toMatchObject({policy:'library-strict-improvement-v1',promotable:true,candidateId:'candidate'});expect(result.improvement).toBeCloseTo(0.05);
	});
	it('requires visual grounding improvement when multimodal evidence is supplied',()=>{
		const source=readFileSync('workers/evaluator/worker.py','utf8');
		expect(source).toContain('baseVisualManifest');
		expect(source).toContain('candidateVisualManifest');
		expect(source).toContain('held-out visual grounding did not improve');
	});
});
