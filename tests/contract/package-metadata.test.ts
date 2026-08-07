import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const packageMetadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const packageManifest = parse(readFileSync(resolve(root, 'treeseed.package.yaml'), 'utf8'));
const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');

describe('AI package metadata', () => {
	it('declares the independent private Apache-2.0 package contract', () => {
		expect(packageMetadata).toMatchObject({ name: '@treeseed/ai', version: '0.1.0', private: true, license: 'Apache-2.0' });
		expect(packageMetadata.scripts).toMatchObject({ build: expect.any(String), test: expect.any(String), verify: expect.any(String) });
	});

	it('disables publishing and deployment', () => {
		expect(packageManifest).toMatchObject({ id: '@treeseed/ai', repository: 'treeseed-ai/ai', capabilities: { publish: false, deploy: false } });
		expect(workflow).not.toMatch(/deploy|publish|secret/i);
	});

	it('claims only the implemented inference foundation and keeps training planned', () => {
		expect(readme).toContain('authenticated OpenAI-compatible inference gateway');
		expect(readme).toContain('Axolotl training remains planned');
	});
});
