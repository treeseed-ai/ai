import type { AiApplianceManifest } from '@treeseed/sdk/ai-appliance';
import { inspectHardware } from '../diagnostics/hardware.js';

async function health(url: string, fetcher: typeof fetch) {
	try { const response = await fetcher(new URL('/health', url), { signal: AbortSignal.timeout(3_000) }); return { ok: response.ok, status: response.status }; } catch (error) { return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }; }
}

export async function applianceStatus(manifest: AiApplianceManifest, fetcher: typeof fetch = fetch) {
	const hardware = inspectHardware();
	const inference = await health(manifest.inference.rawVllmUrl, fetcher);
	return {
		ok: hardware.ready && inference.ok,
		state: inference.ok ? 'ready' : hardware.ready ? 'starting' : 'blocked',
		mode: manifest.mode,
		model: { alias: manifest.inference.publicAlias, source: manifest.inference.model, maxModelLength: manifest.inference.maxModelLength },
		marketGateway: { enabled: manifest.marketGateway.enabled, url: manifest.marketGateway.url },
		providers: manifest.providers,
		hardware,
		services: { inference },
	};
}
