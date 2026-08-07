import { existsSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
	AI_APPLIANCE_SCHEMA_VERSION,DEFAULT_AI_GATEWAY_URL,DEFAULT_AI_MANAGEMENT_URL,DEFAULT_AI_MARKET_URL,DEFAULT_AI_MODEL_ALIAS,DEFAULT_AI_MODEL_ID,
	type AiApplianceManifest,validateAiApplianceManifest,
} from '@treeseed/sdk/ai-appliance';

export const DEFAULT_MANIFEST_PATH = '/etc/treeseed/ai/treeseed.ai-appliance.yaml';

export function defaultAiApplianceManifest(mode: AiApplianceManifest['mode'] = 'joined'): AiApplianceManifest {
	return {
		schemaVersion: AI_APPLIANCE_SCHEMA_VERSION, mode,
		management: { socket: '/run/treeseed-ai/manager.sock', loopbackUrl: DEFAULT_AI_MANAGEMENT_URL },
		marketGateway: { enabled: true, url: DEFAULT_AI_MARKET_URL, audience: DEFAULT_AI_MARKET_URL },
		inference: { publicAlias: DEFAULT_AI_MODEL_ALIAS, model: DEFAULT_AI_MODEL_ID, gatewayUrl: DEFAULT_AI_GATEWAY_URL, rawVllmUrl: 'http://127.0.0.1:8000', maxModelLength: 16_384, maxConcurrentSequences: 1, gpuMemoryUtilization: 0.85, apiKeyRef: 'file:///etc/treeseed/ai/secrets.d/inference-token' },
		providers: {
			agent: { enabled: true, manifest: '/etc/treeseed/ai/providers/agent.yaml' },
			platformOperation: { enabled: true, manifest: '/etc/treeseed/ai/providers/platform-operation.yaml' },
		},
		...(mode === 'standalone' ? { standalone: { localControlPlane: { enabled: true, apiUrl: 'http://127.0.0.1:3000', webUrl: 'http://127.0.0.1:4321' } } } : {}),
	};
}

export function loadAiApplianceManifest(path = process.env.TREESEED_AI_APPLIANCE_MANIFEST ?? DEFAULT_MANIFEST_PATH): AiApplianceManifest {
	const selectedPath = resolve(path);
	if (!existsSync(selectedPath)) throw new Error(`AI appliance manifest does not exist: ${selectedPath}`);
	const manifest = parse(readFileSync(selectedPath, 'utf8')) as AiApplianceManifest;
	const validation = validateAiApplianceManifest(manifest);
	if (!validation.ok) throw new Error(`AI appliance manifest is invalid: ${validation.diagnostics.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
	return manifest;
}

export function readSecretReference(reference: string | undefined, env = process.env) {
	if (!reference) return '';
	if (reference.startsWith('env://')) return env[reference.slice('env://'.length)]?.trim() ?? '';
	if (reference.startsWith('file://')) {
		const path = reference.slice('file://'.length);
		return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
	}
	throw new Error('AI appliance secret references must use env:// or file://.');
}
