import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { componentReleaseSchema } from '@treeseed/sdk/deployment';
import YAML from 'yaml';

const roles = [
	'inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations',
	'training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations',
	'lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'lab-open-webui', 'hermes-agent', 'lab-web-tool-proxy',
];

describe('managed AI component releases', () => {
	it('materializes three immutable bundles without the legacy host manager', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeai-components-'));
		const manifest = resolve(root, 'images.json'), output = resolve(root, 'output');
		writeFileSync(manifest, JSON.stringify({ images: Object.fromEntries(roles.map((role) => [role, {
			repository: `treeseed/${role}`, digest: `sha256:${createHash('sha256').update(role).digest('hex')}`,
			tag: '0.11.0-rc1', buildIdentity: `sha256:${'b'.repeat(64)}`, disposition: 'built', firstBuiltVersion: '0.11.0-rc1',
		}])) }));
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], {
			cwd: process.cwd(), env: { ...process.env, TREEAI_COMPONENT_RELEASE: '0.11.0-rc1', TREEAI_COMPONENT_REVISION: '2', TREEAI_SOURCE_COMMIT: 'a'.repeat(40), TREEAI_IMAGE_MANIFEST: manifest, TREEAI_COMPONENT_OUTPUT: output },
		});
		const expected = new Map([
			['ai-inference', ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations', 'postgres']],
			['ai-training', ['training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations', 'postgres']],
			['ai-lab', ['lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'lab-open-webui', 'hermes-agent', 'lab-web-tool-proxy']],
		]);
		for (const [componentId, componentRoles] of expected) {
			const release = componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(output, `${componentId}-component-release.json`), 'utf8')));
			const compose = readFileSync(resolve(output, `${componentId}-compose.yml`), 'utf8');
			const document = YAML.parse(compose) as { services: Record<string, { image: string; ports?: unknown; networks?: string[]; restart?: string; healthcheck?: unknown; env_file?: unknown; volumes?: Array<string | { source?: string; target?: string }> }>; secrets?: Record<string, { file: string }>; networks?: Record<string, { internal?: boolean }> };
			const acceptedImages = new Set(release.images.map(({ repository, digest }) => `${repository}@${digest}`));
			expect(release.componentId).toBe(componentId);
			expect(release.release).toBe('0.11.0~rc1-2');
			expect(release.images.map(({ role }) => role).sort()).toEqual([...componentRoles].sort());
			expect(release.runtime.compose.files[0]?.digest).toBe(`sha256:${createHash('sha256').update(compose).digest('hex')}`);
			expect(compose).not.toMatch(/\bbuild\s*:/u);
			expect(compose).not.toMatch(/^\s*ports\s*:/mu);
			expect(compose).not.toMatch(/@[A-Z_]+_IMAGE@/u);
			const requiredEnvironment = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?[^}]+\}/gu)].map((match) => match[1]);
			const declaredEnvironment = new Set([...release.runtime.configuration.environment, ...release.runtime.configuration.secretEnvironment].map(({ name }) => name));
			expect(requiredEnvironment.filter((name) => !declaredEnvironment.has(name!))).toEqual([]);
			const declaredSecretFiles = new Set(release.runtime.configuration.secretFiles.map(({ path }) => path));
			expect(Object.values(document.secrets ?? {}).map(({ file }) => file).filter((path) => !declaredSecretFiles.has(path))).toEqual([]);
			for (const service of Object.values(document.services)) {
				expect(acceptedImages.has(service.image), service.image).toBe(true);
				expect(service.ports).toBeUndefined();
				expect(Boolean(service.healthcheck) || service.restart === 'no', `${componentId} service ${service.image} must declare health or one-shot completion`).toBe(true);
			}
			if (componentId === 'ai-lab') {
				expect(compose).not.toContain('ai-shared');
				expect(compose).not.toMatch(/^volumes:/mu);
				expect(compose).toContain('/ai-lab/data/open-webui:/app/backend/data');
				expect(compose).not.toContain('/usr/lib/treeseed-ai');
				expect(release.runtime.stateVolumes).toContainEqual({ id: 'workspace', volume: '/var/lib/treeseed/components/ai-lab/data/workspace', backup: 'required' });
				expect(release.runtime.configuration.secretFiles).toHaveLength(11);
				expect(release.runtime.modeControl).toMatchObject({ role: 'controller', internalControl: { transport: 'mtls', path: '/v1/ai/mode' } });
				expect(compose).not.toContain('factory-control-key');
				expect(compose).not.toContain('FACTORY_URL');
				expect(compose).toContain('WEBUI_AUTH: ${OPEN_WEBUI_AUTH:-false}');
				expect(compose).toContain('ENABLE_LOGIN_FORM: ${OPEN_WEBUI_ENABLE_LOGIN_FORM:-false}');
				expect(compose).toContain('BYPASS_MODEL_ACCESS_CONTROL: ${OPEN_WEBUI_BYPASS_MODEL_ACCESS_CONTROL:-true}');
				expect(compose).toContain('https://chat.ai.treeseed.localhost');
				expect(release.runtime.configuration.environment).toContainEqual({ name: 'OPEN_WEBUI_AUTH', required: false, source: 'configuration', default: 'false' });
			} else {
				expect(compose).toContain('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73');
				expect(compose).toContain(`/${componentId}/data/postgres`);
				expect(release.runtime.stateVolumes).toContainEqual({ id: 'postgres', volume: `/var/lib/treeseed/components/${componentId}/data/postgres`, backup: 'required' });
				if (componentId === 'ai-training') expect(document.services['training-api']?.volumes).toContainEqual({ type: 'bind', source: '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-training/data/training', target: '/artifacts' });
				if (componentId === 'ai-inference') {
					expect(release.runtime.configuration.environment).toContainEqual({ name: 'MAX_NUM_SEQS', required: false, source: 'configuration', default: '2' });
					expect(release.runtime.configuration.environment).toContainEqual({ name: 'GPU_MEMORY_UTILIZATION', required: false, source: 'configuration', default: '0.85' });
					expect(release.runtime.services.flatMap(({ endpoints }) => endpoints).filter(({ healthGate }) => healthGate).every(({ healthGate }) => healthGate?.timeoutSeconds === 1_200)).toBe(true);
					expect(document.services['inference-vllm']?.env_file).toBeUndefined();
					expect(document.services['inference-vllm']?.networks).toEqual(['inference-private', 'inference-model-egress']);
					expect(document.networks?.['inference-model-egress']?.internal).not.toBe(true);
					expect(document.services['inference-api']?.volumes).toContainEqual({ type: 'bind', source: '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-inference/data/artifacts', target: '/artifacts' });
					expect(document.services['inference-api']?.volumes).toContainEqual({ type: 'bind', source: '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-training/data/training', target: '/training-artifacts', read_only: true });
					expect(release.runtime.stateVolumes).toContainEqual({ id: 'artifacts', volume: '/var/lib/treeseed/components/ai-inference/data/artifacts', backup: 'required' });
					expect(release.runtime.configuration.secretFiles.map(({ id }) => id)).toEqual(['artifact-source-registry', 'artifact-destination-registry']);
				}
				if (componentId === 'ai-training') {
					for (const worker of ['training-marker', 'training-axolotl']) {
						expect(document.services[worker]?.env_file).toBeUndefined();
						expect(document.services[worker]?.networks).toEqual(['training-private', 'training-model-egress']);
					}
					expect(document.networks?.['training-model-egress']?.internal).not.toBe(true);
				}
				expect(release.runtime.modeControl).toMatchObject({ resource: 'ai-gpu', role: componentId === 'ai-inference' ? 'inference' : 'training', gate: { executable: '/usr/local/bin/treeseed-ai-gpu-gate' } });
			}
		}
	});
});
