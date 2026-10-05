import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('explains the Lab API at its root without opening protected operations', async () => {
	const root = mkdtempSync(join(tmpdir(), 'treeai-lab-landing-'));
	vi.stubEnv('LAB_STATE_DIR', root);
	vi.stubEnv('AI_LAB_API_KEYS', '[]');
	try {
		const { createLabController } = await import('../../packages/lab/src/controller.js');
		const { app } = createLabController();
		const response = await app.request('/');
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		const html = await response.text();
		expect(html).toContain('backend API, not the chat application');
		expect(html).toContain('href="/docs"');
		expect(html).toContain('href="/openapi.json"');
		expect((await app.request('/v1/status')).status).toBe(401);
	} finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
});
