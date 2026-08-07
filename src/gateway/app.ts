import { Hono } from 'hono';
import type { AiApplianceManifest } from '@treeseed/sdk/ai-appliance';
import { bearerAuthorization } from './authorization.js';
import { proxyInferenceRequest } from './proxy.js';

export function createInferenceGateway(input: { manifest: AiApplianceManifest; token: string; fetch?: typeof fetch }) {
	const app = new Hono();
	app.get('/healthz', (context) => context.json({ ok: true, service: 'ai-inference-gateway', model: input.manifest.inference.publicAlias }));
	app.use('/v1/*', bearerAuthorization(input.token));
	const proxy = (context: Parameters<typeof proxyInferenceRequest>[0]) => proxyInferenceRequest(context, { rawBaseUrl: input.manifest.inference.rawVllmUrl, alias: input.manifest.inference.publicAlias, model: input.manifest.inference.model, fetch: input.fetch });
	app.get('/v1/models', proxy);
	app.post('/v1/chat/completions', proxy);
	app.post('/v1/responses', proxy);
	app.notFound((context) => context.json({ error: { code: 'route_not_supported', message: 'Only the OpenAI-compatible models, chat completions, and responses routes are available.', type: 'invalid_request_error' } }, 404));
	app.onError((error, context) => context.json({ error: { code: 'inference_upstream_unavailable', message: error.message, type: 'api_error' } }, 502));
	return app;
}
