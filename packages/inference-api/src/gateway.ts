import type { ApiKeyResolver } from '@ai-platform/common';
import { apiKeyAuthorization,requireScope } from '@ai-platform/common';
import { Hono,type Context } from 'hono';
import{existsSync,mkdirSync,readFileSync,renameSync,writeFileSync}from'node:fs';import{dirname}from'node:path';

const skippedHeaders = new Set(['connection','content-length','host','keep-alive','transfer-encoding','upgrade']);

export function createInferenceGateway(input: { rawVllmUrl: string; publicModel: string; sourceModel: string; resolveModel?:(requested:string)=>Promise<string|null>; listModels?:()=>Promise<Array<{id:string;root:string}>>; resolveKey: ApiKeyResolver; fetch?: typeof fetch }) {
	const app = new Hono(); const fetcher = input.fetch ?? fetch;let active=0;const admissionPath=process.env.TREESEED_GPU_ADMISSION_FILE,legacyModePath=process.env.AI_FACTORY_MODE_FILE,statusPath=process.env.TREESEED_GPU_ACTIVITY_FILE??process.env.AI_RUNTIME_STATUS;const admitted=()=>{try{if(admissionPath)return existsSync(admissionPath)&&JSON.parse(readFileSync(admissionPath,'utf8')).admission==='open';return legacyModePath&&existsSync(legacyModePath)?JSON.parse(readFileSync(legacyModePath,'utf8')).mode==='awake':true;}catch{return false;}};const status=()=>{if(!statusPath)return;mkdirSync(dirname(statusPath),{recursive:true});const temporary=`${statusPath}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify({active,updatedAt:new Date().toISOString()}));renameSync(temporary,statusPath);};
	app.get('/healthz', (context) => context.json({ ok: true, service: 'inference-data-plane' }));
	app.use('/v1/*', apiKeyAuthorization(input.resolveKey));
	app.use('/v1/*', requireScope('inference:invoke'));
	const proxy = async (context: Context) => {
		if(!admitted())return context.json({error:{code:'inference_sleeping',message:'Inference is unavailable while the managed GPU is in training mode.'}},503);
		active++;status();
		try{
		const path = new URL(context.req.url).pathname;
		const body = context.req.method === 'GET' ? undefined : await context.req.json().catch(() => ({})) as Record<string,unknown>;
		const requested=String(body?.model??input.publicModel),selectedModel=await(input.resolveModel?.(requested)??(requested===input.publicModel?input.sourceModel:null));
		if(!selectedModel){active--;status();return context.json({error:{code:'model_not_found',message:`Model ${requested} is not deployed.`}},404);}
		if (body?.model) body.model = selectedModel;
		const upstream = await fetcher(new URL(path, input.rawVllmUrl), { method: context.req.method, headers: { 'content-type': 'application/json', 'x-request-id': context.req.header('x-request-id') ?? crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined, signal: context.req.raw.signal });
		if (path === '/v1/models' && upstream.ok){const models=await(input.listModels?.()??[{id:input.publicModel,root:selectedModel}]);active--;status();return context.json({ object: 'list', data: models.map((model)=>({id:model.id,object:'model',owned_by:'local-ai',root:model.root})) });}
		const headers = new Headers(); for (const [key,value] of upstream.headers) if (!skippedHeaders.has(key.toLowerCase())) headers.set(key,value);
		if(!upstream.body){active--;status();return new Response(null,{status:upstream.status,statusText:upstream.statusText,headers});}const reader=upstream.body.getReader();const bodyStream=new ReadableStream({async pull(controller){const value=await reader.read();if(value.done){active--;status();controller.close();}else controller.enqueue(value.value);},async cancel(){await reader.cancel();active--;status();}});return new Response(bodyStream, { status: upstream.status, statusText: upstream.statusText, headers });
		}catch(error){active--;status();throw error;}
	};
	app.get('/v1/models', proxy); app.post('/v1/responses', proxy); app.post('/v1/chat/completions', proxy);
	app.notFound((context) => context.json({ error: { code: 'route_not_supported', message: 'Unsupported inference route.' } }, 404));
	app.onError((error, context) => context.json({ error: { code: 'inference_upstream_unavailable', message: error.message } }, 502));
	return app;
}
