import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe,expect,it } from 'vitest';
import { validateCapacityProviderManifestV2 } from '@treeseed/sdk/capacity-provider';
import { defaultAiApplianceManifest } from '../../src/config/manifest.ts';

describe('appliance manifests', () => {
	it('uses the canonical global connection and constrained model profile', () => {
		const manifest = defaultAiApplianceManifest();
		expect(manifest.marketGateway.url).toBe('https://api.treeseed.dev');
		expect(manifest.inference).toMatchObject({ publicAlias: 'treeseed-qwen3.5-4b', model: 'Qwen/Qwen3.5-4B', maxModelLength: 16_384, maxConcurrentSequences: 1 });
	});

	it('declares all requested execution providers in a valid provider manifest', () => {
		const manifest = parse(readFileSync(new URL('../../config/providers/agent.yaml', import.meta.url), 'utf8'));
		expect(validateCapacityProviderManifestV2(manifest)).toEqual({ ok: true, diagnostics: [] });
		expect(manifest.executionProviders.map((entry: { id: string }) => entry.id)).toEqual(['codex-sub', 'codex-key', 'codex-treeseed', 'ghcopilot-key', 'ghcopilot-treeseed', 'opencode-sub', 'opencode-key', 'opencode-treeseed']);
	});

	it('configures OpenCode to use the authenticated appliance gateway by default', () => {
		const config = JSON.parse(readFileSync(new URL('../../config/opencode/opencode.json', import.meta.url), 'utf8'));
		expect(config).toMatchObject({
			model: 'treeseed/treeseed-qwen3.5-4b',
			provider: { treeseed: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://host.docker.internal:4771/v1', apiKey: '{env:TREESEED_AI_GATEWAY_TOKEN}' } } },
		});
	});
});
