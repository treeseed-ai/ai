#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { reconcileAiAppliance } from '@treeseed/sdk/ai-appliance';
import { createInferenceGateway } from '../gateway/app.js';
import { createManagementApp } from '../management/app.js';
import { DEFAULT_MANIFEST_PATH,loadAiApplianceManifest,readSecretReference } from '../config/manifest.js';
import { inspectHardware } from '../diagnostics/hardware.js';
import { applianceStatus } from '../runtime/status.js';
import { startReconciliationLoop } from '../runtime/supervisor.js';

function option(name: string) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function output(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
	const command = process.argv[2] ?? 'status';
	if (command === 'diagnose') return output(inspectHardware());
	const manifestPath = option('--manifest') ?? process.env.TREESEED_AI_APPLIANCE_MANIFEST ?? DEFAULT_MANIFEST_PATH;
	const manifest = loadAiApplianceManifest(manifestPath);
	const tenantRoot = resolve(option('--root') ?? process.env.TREESEED_AI_ROOT ?? process.cwd());
	const packageRoot = resolve(option('--package-root') ?? process.env.TREESEED_AI_PACKAGE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)));
	const composeFile = resolve(packageRoot, 'compose.ai.yml');
	if (command === 'status') return output(await applianceStatus(manifest));
	if (command === 'plan' || command === 'apply') return output(await reconcileAiAppliance({ tenantRoot, manifest, composeFile, plan: command === 'plan' }));
	if (command === 'serve' || command === 'supervise') {
		const token = readSecretReference(manifest.inference.apiKeyRef);
		const managementPort = Number(new URL(manifest.management.loopbackUrl ?? 'http://127.0.0.1:4770').port || 4770);
		const gatewayUrl = new URL(manifest.inference.gatewayUrl);
		serve({ fetch: createManagementApp({ manifest, tenantRoot, composeFile }).fetch, hostname: '127.0.0.1', port: managementPort });
		serve({ fetch: createInferenceGateway({ manifest, token }).fetch, hostname: gatewayUrl.hostname, port: Number(gatewayUrl.port || 4771) });
		output({ ok: true, management: manifest.management.loopbackUrl, gateway: manifest.inference.gatewayUrl, model: manifest.inference.publicAlias });
		if (command === 'supervise') startReconciliationLoop({
			reconcile: () => reconcileAiAppliance({ tenantRoot, manifest, composeFile, plan: false }),
			onState: (state) => { if (!state.running && state.lastError) process.stderr.write(`AI appliance reconciliation is blocked: ${state.lastError}\n`); },
		});
		return;
	}
	throw new Error(`Unknown command ${command}. Use diagnose, status, plan, apply, serve, or supervise.`);
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
