import type { Context } from 'hono';

const skippedHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'transfer-encoding', 'upgrade']);

function responseHeaders(source: Headers) {
	const headers = new Headers();
	for (const [key, value] of source) if (!skippedHeaders.has(key.toLowerCase())) headers.set(key, value);
	return headers;
}

function replaceModel(value: unknown, alias: string, model: string): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
	const record = value as Record<string, unknown>;
	return { ...record, ...(record.model === alias ? { model } : {}) };
}

export async function proxyInferenceRequest(context: Context, input: { rawBaseUrl: string; alias: string; model: string; fetch?: typeof fetch }) {
	const fetcher = input.fetch ?? fetch;
	const path = new URL(context.req.url).pathname;
	const body = context.req.method === 'GET' ? undefined : replaceModel(await context.req.json().catch(() => ({})), input.alias, input.model);
	const upstream = await fetcher(new URL(path, input.rawBaseUrl), {
		method: context.req.method,
		headers: { 'content-type': 'application/json', 'x-request-id': context.req.header('x-request-id') ?? crypto.randomUUID() },
		body: body === undefined ? undefined : JSON.stringify(body), signal: context.req.raw.signal,
	});
	if (path === '/v1/models' && upstream.ok) {
		const payload = await upstream.json() as Record<string, unknown>;
		return context.json({ ...payload, data: [{ id: input.alias, object: 'model', owned_by: 'treeseed-ai', root: input.model }] }, upstream.status as 200);
	}
	return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders(upstream.headers) });
}
