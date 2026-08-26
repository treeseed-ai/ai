import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe,expect,it} from 'vitest';

describe('library adapter ranking',()=>{
	it('requires two percent lower held-out NLL and no general regression',()=>{
		const modulePath=JSON.stringify(join(process.cwd(),'workers/evaluator/worker.py'));
		const result=JSON.parse(execFileSync('python3',['-c',`import importlib.util,json,os,pathlib,sys,tempfile,types\nsys.modules['boto3']=types.SimpleNamespace(client=lambda *a,**k:None)\nserver=types.ModuleType('common.server');server.serve=lambda routes:None\nsys.modules['common']=types.ModuleType('common');sys.modules['common.server']=server\nwith tempfile.TemporaryDirectory() as d:\n os.environ['STATE_DIR']=d;s=importlib.util.spec_from_file_location('evaluator',${modulePath});m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n general={'results':[{'candidate':'base','categories':{'quality':0.8},'criticalChecksPassed':True},{'candidate':'candidate','categories':{'quality':0.8},'criticalChecksPassed':True}]}\n pathlib.Path(d,'general.json').write_text(json.dumps(general))\n evidence={'schemaVersion':'ai.library-likelihood-evaluation/v1','metric':'completion-negative-log-likelihood','baseValue':2.0,'candidateValue':1.9,'evaluationObject':{'sha256':'a'*64,'size':100}}\n output=m.rank_library({'jobId':'rank','input':{'candidateId':'candidate','generalManifest':f'file://{d}/general.json','likelihoodEvidence':evidence}})\n print(pathlib.Path(output['resultManifest'][7:]).read_text())`],{cwd:process.cwd(),encoding:'utf8'}));
		expect(result).toMatchObject({policy:'library-strict-improvement-v1',promotable:true,candidateId:'candidate'});expect(result.improvement).toBeCloseTo(0.05);
	});
	it('requires visual grounding improvement when multimodal evidence is supplied',()=>{
		const source=readFileSync('workers/evaluator/worker.py','utf8');
		expect(source).toContain('baseVisualManifest');
		expect(source).toContain('candidateVisualManifest');
		expect(source).toContain('held-out visual grounding did not improve');
	});
	it('packages and validates the versioned default suite in the evaluator image',()=>{
		const dockerfile=readFileSync('containers/inference/evaluator.Dockerfile','utf8'),suite=JSON.parse(readFileSync('workers/evaluator/suites/default-v1.json','utf8'));
		expect(dockerfile).toContain('ENV SUITE_DIR=/app/evaluator/suites');
		expect(dockerfile).toContain("value.get('schemaVersion') == 'ai.evaluation-suite/v1'");
		expect(suite.schemaVersion).toBe('ai.evaluation-suite/v1');
		expect(suite.cases.length).toBeGreaterThan(0);
	});
	it('distinguishes private object-store failures from private inference failures',()=>{
		const source=readFileSync('workers/evaluator/worker.py','utf8');
		expect(source).toContain('inference object store read failed:');
		expect(source).toContain('private vLLM request failed:');
		expect(source.indexOf('except urllib.error.HTTPError')).toBeLessThan(source.indexOf('except urllib.error.URLError'));
		expect(source).toContain('private vLLM HTTP {error.code}');
		expect(source).toContain('urllib.request.ProxyHandler({})');
		expect(source).not.toContain('urllib.request.urlopen(request');
		expect(source).not.toContain('AWS_SECRET_ACCESS_KEY}');
	});
	it('uses canonical Compose discovery and probes the no-proxy HTTP path',()=>{
		const override=readFileSync('deploy/inference/factory.override.yml','utf8'),compose=readFileSync('deploy/inference/compose.yml','utf8');
		expect(override).not.toContain('network_mode: "service:vllm"');
		expect(override).toContain('VLLM_URL: http://vllm:8000');
		expect(override).toContain('EVALUATOR_URL: "http://evaluator:8080"');
		expect(override).not.toContain('aliases: [inference-vllm]');
		expect(compose).toContain("open('http://127.0.0.1:8080/healthz',timeout=3)");
	});
});
