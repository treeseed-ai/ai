import { Hono } from 'hono';
import { reconcileAiAppliance,type AiApplianceManifest } from '@treeseed/sdk/ai-appliance';
import { applianceStatus } from '../runtime/status.js';

export function createManagementApp(input: { manifest: AiApplianceManifest; tenantRoot: string; composeFile?: string; fetch?: typeof fetch; reconcile?: typeof reconcileAiAppliance }) {
	const app = new Hono();
	const status = () => applianceStatus(input.manifest, input.fetch);
	app.get('/healthz', async (context) => { const value = await status(); return context.json(value, value.ok ? 200 : 503); });
	app.get('/v1/status', async (context) => context.json(await status()));
	app.get('/v1/topology', (context) => context.json({ mode: input.manifest.mode, marketGateway: input.manifest.marketGateway, inference: { ...input.manifest.inference, apiKeyRef: input.manifest.inference.apiKeyRef ? '[configured]' : null }, providers: input.manifest.providers }));
	app.get('/v1/hardware', async (context) => context.json((await status()).hardware));
	app.get('/v1/models', (context) => context.json({ items: [{ id: input.manifest.inference.publicAlias, source: input.manifest.inference.model, active: true }] }));
	app.get('/v1/providers', (context) => context.json({
		defaultMarket: input.manifest.marketGateway.url,
		items: [
			{ providerClass: 'agent', ...input.manifest.providers.agent },
			{ providerClass: 'platform-operation', ...input.manifest.providers.platformOperation },
		].map((provider) => ({
			...provider,
			join: `trsd capacity provider-join --provider-class ${provider.providerClass} --config ${provider.manifest} --connection <connection-id> --registration-key-ref <secret-ref> --execute --json`,
		})),
	}));
	app.post('/v1/reconciliation/plan', async (context) => context.json(await (input.reconcile ?? reconcileAiAppliance)({ tenantRoot: input.tenantRoot, manifest: input.manifest, composeFile: input.composeFile, plan: true })));
	app.post('/v1/reconciliation/apply', async (context) => context.json(await (input.reconcile ?? reconcileAiAppliance)({ tenantRoot: input.tenantRoot, manifest: input.manifest, composeFile: input.composeFile, plan: false })));
	app.notFound((context) => context.json({ ok: false, code: 'management_route_not_found' }, 404));
	app.onError((error, context) => context.json({ ok: false, code: 'management_operation_failed', error: error.message }, 409));
	return app;
}
