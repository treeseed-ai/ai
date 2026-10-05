import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readAiDatabaseUrl, validateAiDatabaseUrl } from '../../packages/common/src/database/connection.js';
import { applyAiMigrations } from '../../packages/common/src/database/migrations.js';

const fs = vi.hoisted(() => ({ openSync: vi.fn(), closeSync: vi.fn(), fstatSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<object>(), ...fs }));
const path = '/run/treeseed/postgres/ai-inference/url';
const url = `postgresql://inference_runtime:private@postgres:5432/inference?sslmode=verify-full&sslrootcert=${path.replace('/url','/ca.pem')}`;
beforeEach(() => {
	vi.spyOn(process, 'getuid').mockReturnValue(1000);
	fs.openSync.mockReturnValue(4);
	fs.fstatSync.mockReturnValue({ isFile: () => true, nlink: 1, uid: 1000, mode: 0o400, size: url.length });
	fs.readFileSync.mockImplementation(() => Buffer.from(url));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('reads only the selected protected allocation mount and zeroes the temporary buffer', () => {
	const buffer = Buffer.from(url); fs.readFileSync.mockReturnValue(buffer);
	expect(readAiDatabaseUrl('inference', { TREESEED_DATABASE_URL_FILE: path })).toBe(url);
	expect(buffer.every(byte => byte === 0)).toBe(true); expect(fs.closeSync).toHaveBeenCalledWith(4);
});
it.each([{ DATABASE_URL: url }, { TREESEED_DATABASE_URL_FILE: '/tmp/url' },
	{ TREESEED_DATABASE_URL_FILE: path, DATABASE_URL: url }])('rejects ambient or conflicting input without opening a file', env => {
	expect(() => readAiDatabaseUrl('inference', env)).toThrow('unavailable or unsafe'); expect(fs.openSync).not.toHaveBeenCalled();
});
it.each([{ uid: 0 }, { mode: 0o644 }, { nlink: 2 }, { size: 20000 }])('rejects unsafe credential metadata %j', change => {
	fs.fstatSync.mockReturnValue({ isFile: () => true, nlink: 1, uid: 1000, mode: 0o400, size: 200, ...change });
	expect(() => readAiDatabaseUrl('inference', { TREESEED_DATABASE_URL_FILE: path })).toThrow('unavailable or unsafe');
});
it.each([url.replace('verify-full','require'), url.replace('inference_runtime','postgres'),
	url.replace('ai-inference','ai-training'), `${url}&sslmode=disable`, `${url}&options=unsafe`, 'not-a-url'])('rejects invalid TLS/authority without leaking input', value => {
	expect(() => validateAiDatabaseUrl(value, 'inference')).toThrow('Invalid managed AI database binding');
});
const file = { name: '001_initial.sql', sql: 'CREATE TABLE example(id integer)' };
it('commits migration and checksum together and replays already accepted files as noop', async () => {
	const queries: string[] = []; let accepted = false;
	const session = { query: async (sql: string) => {
		queries.push(sql);
		if (sql.startsWith('INSERT INTO')) accepted = true;
		return { rows: sql.startsWith('SELECT checksum') && accepted ? [{ checksum: createHash('sha256').update(file.sql).digest('hex') }] : [] };
	} };
	await applyAiMigrations(session, 'inference', [file]); await applyAiMigrations(session, 'inference', [file]);
	expect(queries.filter(sql => sql === file.sql)).toHaveLength(1);
	expect(queries.indexOf('BEGIN')).toBeLessThan(queries.indexOf(file.sql));
	expect(queries.indexOf('COMMIT')).toBeGreaterThan(queries.findIndex(sql => sql.startsWith('INSERT INTO')));
});
it('rolls back failed DDL without recording its checksum or exposing SQL errors', async () => {
	const queries: string[] = [];
	const session = { query: async (sql: string) => { queries.push(sql); if (sql === file.sql) throw new Error('secret-data'); return { rows: [] }; } };
	await expect(applyAiMigrations(session, 'training', [file])).rejects.toThrow('AI database migration failed');
	expect(queries).toContain('ROLLBACK'); expect(queries.some(sql => sql.startsWith('INSERT INTO'))).toBe(false);
});
it('rejects changed accepted checksums before executing DDL', async () => {
	const query = vi.fn(async () => ({ rows: [{ checksum: 'wrong' }] }));
	await expect(applyAiMigrations({ query }, 'inference', [file])).rejects.toThrow('checksums');
	expect(query.mock.calls.some(([sql]) => sql === file.sql)).toBe(false);
});
