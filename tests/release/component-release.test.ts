import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { componentReleaseSchema } from '@treeseed/sdk/deployment';

const roles = [
	'inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations',
	'training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations',
	'lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'hermes-agent', 'lab-web-tool-proxy',
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
			['ai-inference', ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations']],
			['ai-training', ['training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations']],
			['ai-lab', ['lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'hermes-agent', 'lab-web-tool-proxy']],
		]);
		for (const [componentId, componentRoles] of expected) {
			const release = componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(output, `${componentId}-component-release.json`), 'utf8')));
			const compose = readFileSync(resolve(output, `${componentId}-compose.yml`), 'utf8');
			expect(release.componentId).toBe(componentId);
			expect(release.release).toBe('0.11.0~rc1-2');
			expect(release.images.map(({ role }) => role).sort()).toEqual([...componentRoles].sort());
			expect(release.runtime.compose.files[0]?.digest).toBe(`sha256:${createHash('sha256').update(compose).digest('hex')}`);
			expect(compose).not.toMatch(/\bbuild\s*:/u);
			expect(compose).not.toMatch(/^\s*ports\s*:/mu);
			 expect(compose).not.toMatch(/@[A-Z_]+_IMAGE@/u);
			if (componentId === 'ai-lab') {
				expect(compose).not.toContain('ai-shared');
				expect(compose).not.toMatch(/^volumes:/mu);
				expect(compose).toContain('/ai-lab/data/open-webui:/app/backend/data');
			}
		}
	});
});
