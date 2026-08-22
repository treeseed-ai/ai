import type { ApiKeyResolver } from '@ai-platform/common';
import { apiKeyAuthorization,requireScope } from '@ai-platform/common';
import { Hono,type Context } from 'hono';
import{existsSync,mkdirSync,readFileSync,renameSync,writeFileSync}from'node:fs';import{dirname}from'node:path';

const skippedHeaders = new Set(['connection','content-length','host','keep-alive','transfer-encoding','upgrade']);

export function createInferenceGateway(input: { rawVllmUrl: string; publicModel: string; sourceModel: string; resolveKey: ApiKeyResolver; resolveModel?:()=>Promise<string>; fetch?: typeof fetch }) {
	const app = new Hono(); const fetcher = input.fetch ?? fetch;let active=0;const modePath=process.env.AI_FACTORY_MODE_FILE,statusPath=process.env.AI_RUNTIME_STATUS;const mode=()=>{try{return modePath&&existsSync(modePath)?JSON.parse(readFileSync(modePath,'utf8')).mode:'awake';}catch{return'degraded';}};const status=()=>{if(!statusPath)return;mkdirSync(dirname(statusPath),{recursive:true});const temporary=`${statusPath}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify({active,updatedAt:new Date().toISOString()}));renameSync(temporary,statusPath);};
	app.get('/healthz', (context) => context.json({ ok: true, service: 'inference-data-plane' }));
	app.use('/v1/*', apiKeyAuthorization(input.resolveKey));
	app.use('/v1/*', requireScope('inference:invoke'));
	const proxy = async (context: Context) => {
		if(mode()!=='awake')return context.json({error:{code:'inference_sleeping',message:'Inference is unavailable while the factory is in training mode.'}},503);
		active++;status();
		try{
		const path = new URL(context.req.url).pathname;
		const selectedModel=await(input.resolveModel?.()??input.sourceModel);
		const body = context.req.method === 'GET' ? undefined : await context.req.json().catch(() => ({})) as Record<string,unknown>;
		if (body?.model === input.publicModel) body.model = selectedModel;
		const upstream = await fetcher(new URL(path, input.rawVllmUrl), { method: context.req.method, headers: { 'content-type': 'application/json', 'x-request-id': context.req.header('x-request-id') ?? crypto.randomUUID() }, body: body ? JSON.stringify(body) : undefined, signal: context.req.raw.signal });
		if (path === '/v1/models' && upstream.ok){active--;status();return context.json({ object: 'list', data: [{ id: input.publicModel, object: 'model', owned_by: 'local-ai', root: selectedModel }] });}
		const headers = new Headers(); for (const [key,value] of upstream.headers) if (!skippedHeaders.has(key.toLowerCase())) headers.set(key,value);
		if(!upstream.body){active--;status();return new Response(null,{status:upstream.status,statusText:upstream.statusText,headers});}const reader=upstream.body.getReader();const bodyStream=new ReadableStream({async pull(controller){const value=await reader.read();if(value.done){active--;status();controller.close();}else controller.enqueue(value.value);},async cancel(){await reader.cancel();active--;status();}});return new Response(bodyStream, { status: upstream.status, statusText: upstream.statusText, headers });
		}catch(error){active--;status();throw error;}
	};
	app.get('/v1/models', proxy); app.post('/v1/responses', proxy); app.post('/v1/chat/completions', proxy);
	app.notFound((context) => context.json({ error: { code: 'route_not_supported', message: 'Unsupported inference route.' } }, 404));
	app.onError((error, context) => context.json({ error: { code: 'inference_upstream_unavailable', message: error.message } }, 502));
	return app;
}
