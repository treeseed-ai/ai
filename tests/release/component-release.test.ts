import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { componentReleaseSchema } from '@treeseed/sdk/deployment';

const roles = ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations', 'training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations'];

describe('managed AI component release', () => {
	it('materializes an immutable Compose bundle independently of the host manager', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeai-component-'));
		const manifest = resolve(root, 'images.json'), output = resolve(root, 'output');
		writeFileSync(manifest, JSON.stringify({ images: Object.fromEntries(roles.map((role) => [role, { repository: `treeseed/${role}`, digest: `sha256:${createHash('sha256').update(role).digest('hex')}` }])) }));
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], {
			cwd: process.cwd(),
			env: { ...process.env, TREEAI_COMPONENT_RELEASE: '0.10.0-rc3', TREEAI_COMPONENT_REVISION: '2', TREEAI_SOURCE_COMMIT: 'a'.repeat(40), TREEAI_IMAGE_MANIFEST: manifest, TREEAI_COMPONENT_OUTPUT: output },
		});
		const release = componentReleaseSchema.parse(JSON.parse(readFileSync(resolve(output, 'component-release.json'), 'utf8')));
		const compose = readFileSync(resolve(output, 'compose.yml'), 'utf8');
		expect(release.release).toBe('0.10.0~rc3-2');
		expect(release.runtime.compose.files[0]?.digest).toBe(`sha256:${createHash('sha256').update(compose).digest('hex')}`);
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).not.toMatch(/^\s*ports\s*:/mu);
		expect(compose).not.toMatch(/@[A-Z_]+_IMAGE@/u);
	});
});
