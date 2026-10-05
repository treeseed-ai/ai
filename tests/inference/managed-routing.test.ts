import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import YAML from 'yaml';
import { hashApiKey } from '../../packages/common/src/index.js';
import { createInferenceGateway } from '../../packages/inference-api/src/gateway.js';

it('completes a discovered public model against the exact managed vLLM served name', async () => {
	const compose = YAML.parse(readFileSync('deploy/component/compose.template.yml', 'utf8'));
	const engine = compose.services['inference-vllm'];
	const resolve = (value: string) => value.replace(/\$\{[^:}]+:-([^}]+)\}/g, '$1');
	const served = resolve(engine.command[engine.command.indexOf('--served-model-name') + 1]);
	expect(resolve(engine.environment.TREESEED_VLLM_MODEL)).toBe(served);
	const calls: string[] = [];
	const app = createInferenceGateway({
		rawVllmUrl: 'http://vllm:8000', publicModel: 'local-model', sourceModel: 'Qwen/Qwen3.5-4B',
		resolveKey: async id => id === 'test' ? { id, hash: hashApiKey('secret', 'salt'), scopes: ['inference:invoke'], revoked: false } : null,
		fetch: (async (url, init) => {
			if (String(url).endsWith('/models')) return Response.json({ data: [{ id: served }] });
			const model = JSON.parse(String(init?.body)).model;
			calls.push(model);
			return model === served ? Response.json({ choices: [{ message: { content: 'Hello' } }] }) : Response.json({ error: 'Model does not exist' }, { status: 404 });
		}) as typeof fetch,
	});
	const headers = { authorization: 'Bearer ak_test_secret', 'content-type': 'application/json' };
	const models = await (await app.request('/v1/models', { headers })).json();
	for (const path of ['/v1/chat/completions', '/v1/responses']) {
		const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify({ model: models.data[0].id, messages: [{ role: 'user', content: 'Hello' }] }) });
		expect(response.status).toBe(200);
		expect(await response.json()).toHaveProperty('choices');
	}
	expect(calls).toEqual([served, served]);
	expect((await app.request('/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'missing' }) })).status).toBe(404);
});
