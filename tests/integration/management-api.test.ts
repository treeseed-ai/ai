import { describe,expect,it,vi } from 'vitest';
import { defaultAiApplianceManifest } from '../../src/config/manifest.ts';
import { createManagementApp } from '../../src/management/app.ts';

describe('management API', () => {
	it('redacts secret references from topology output', async () => {
		const app = createManagementApp({ manifest: defaultAiApplianceManifest(), tenantRoot: process.cwd(), fetch: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch });
		const response = await app.request('/v1/topology');
		expect(await response.json()).toMatchObject({ inference: { apiKeyRef: '[configured]' } });
	});

	it('keeps plan and apply as distinct reconciliation modes', async () => {
		const reconcile = vi.fn(async (input: { plan: boolean }) => ({ plan: input.plan, ok: true })) as never;
		const app = createManagementApp({ manifest: defaultAiApplianceManifest(), tenantRoot: process.cwd(), reconcile });
		expect(await (await app.request('/v1/reconciliation/plan', { method: 'POST' })).json()).toEqual({ plan: true, ok: true });
		expect(await (await app.request('/v1/reconciliation/apply', { method: 'POST' })).json()).toEqual({ plan: false, ok: true });
	});

	it('publishes canonical team-join commands without accepting invite keys', async () => {
		const app = createManagementApp({ manifest: defaultAiApplianceManifest(), tenantRoot: process.cwd() });
		const payload = await (await app.request('/v1/providers')).json() as { defaultMarket: string; items: Array<{ join: string }> };
		expect(payload.defaultMarket).toBe('https://api.treeseed.dev');
		expect(payload.items).toHaveLength(2);
		expect(payload.items[0]!.join).toContain('trsd capacity provider-join');
		expect(JSON.stringify(payload)).not.toContain('invite');
	});
});
