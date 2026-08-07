import { describe,expect,it,vi } from 'vitest';
import { defaultAiApplianceManifest } from '../../src/config/manifest.ts';
import { createInferenceGateway } from '../../src/gateway/app.ts';

describe('inference gateway', () => {
	it('fails closed without the appliance bearer token', async () => {
		const response = await createInferenceGateway({ manifest: defaultAiApplianceManifest(), token: 'expected' }).request('/v1/models');
		expect(response.status).toBe(401);
	});

	it('maps the public alias to Qwen for Responses API requests', async () => {
		const upstream = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'Qwen/Qwen3.5-4B', input: 'hello', stream: true });
			return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
		});
		const app = createInferenceGateway({ manifest: defaultAiApplianceManifest(), token: 'secret', fetch: upstream as typeof fetch });
		const response = await app.request('/v1/responses', { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'treeseed-qwen3.5-4b', input: 'hello', stream: true }) });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('response.completed');
		expect(upstream).toHaveBeenCalledOnce();
	});

	it('supports Chat Completions and publishes only the stable model alias', async () => {
		const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).endsWith('/v1/models')) return Response.json({ object: 'list', data: [{ id: 'internal' }] });
			expect(JSON.parse(String(init?.body)).model).toBe('Qwen/Qwen3.5-4B');
			return Response.json({ id: 'chat-1', choices: [] });
		});
		const app = createInferenceGateway({ manifest: defaultAiApplianceManifest(), token: 'secret', fetch: upstream as typeof fetch });
		const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
		const chat = await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'treeseed-qwen3.5-4b', messages: [] }) });
		expect(chat.status).toBe(200);
		const models = await app.request('/v1/models', { headers });
		expect(await models.json()).toMatchObject({ data: [{ id: 'treeseed-qwen3.5-4b', root: 'Qwen/Qwen3.5-4B' }] });
	});
});
