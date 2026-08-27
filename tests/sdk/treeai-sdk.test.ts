import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TreeAiApiError, TreeAiClient } from '../../packages/treeai-sdk/src/index.js';
import { TREEAI_OPENAPI_CONTRACTS, TREEAI_OPERATIONS } from '../../packages/treeai-sdk/src/generated/contract.js';

const endpoints = {
	inference: 'https://inference.example', training: 'https://training.example',
	lab: 'https://lab.example', qualification: 'https://qualification.example',
} as const;

describe('generic TreeAI SDK contract', () => {
	it('publishes four OpenAPI 3.1.1 contracts with one unique inventory entry per operation', () => {
		const ids = TREEAI_OPERATIONS.map(({ operationId }) => operationId);
		expect(new Set(ids).size).toBe(ids.length);
		for (const service of Object.keys(TREEAI_OPENAPI_CONTRACTS)) {
			const document = JSON.parse(readFileSync(`packages/treeai-sdk/openapi/${service}.json`, 'utf8')) as { openapi: string; paths: Record<string, unknown> };
			expect(document.openapi).toBe('3.1.1');
			expect(Object.keys(document.paths).length).toBeGreaterThan(0);
		}
	});

	it('keeps package update and reconciliation authority out of the generic qualification contract', () => {
		const paths = JSON.parse(readFileSync('packages/treeai-sdk/openapi/qualification.json', 'utf8')).paths as Record<string, unknown>;
		expect(Object.keys(paths)).not.toContain('/v1/updates');
		expect(Object.keys(paths)).not.toContain('/v1/reconcile');
		expect(Object.keys(paths)).toContain('/v1/qualification/campaigns');
	});

	it('dispatches only cataloged operations with path parameters, authentication, and typed failures', async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ id: 'adapter-1' }), { status: 200, headers: { 'content-type': 'application/json' } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'not_found', message: 'Missing' } }), { status: 404, headers: { 'content-type': 'application/json' } }));
		const client = new TreeAiClient({ endpoints, token: async () => 'secret', fetch: request });
		await expect(client.invoke('inference.get.adapters.by-id', { path: { id: 'adapter/1' } })).resolves.toEqual({ id: 'adapter-1' });
		const [url, init] = request.mock.calls[0]!;
		expect(String(url)).toBe('https://inference.example/v1/adapters/adapter%2F1');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
		await expect(client.invoke('inference.get.adapters.by-id', { path: { id: 'missing' } })).rejects.toMatchObject<TreeAiApiError>({ status: 404, code: 'not_found' });
	});
});
