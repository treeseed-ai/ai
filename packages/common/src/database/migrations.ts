import { createHash } from 'node:crypto';
import type { AiDatabase } from './connection.js';

export interface MigrationSession {
	query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** The Deployment migrator login selects the owner role at connection time.
 * Serialize migrations and commit each file together with its checksum receipt.
 */
export async function applyAiMigrations(session: MigrationSession, product: AiDatabase, files: Array<{ name: string; sql: string }>) {
	if (!['inference','training'].includes(product) || !files.length ||
		files.some(file => !/^[0-9]+_[a-z0-9_-]+\.sql$/u.test(file.name)) || new Set(files.map(file => file.name)).size !== files.length) throw new Error('Invalid AI migration inventory');
	let locked = false;
	try {
		await session.query('SELECT pg_advisory_lock(1953654116, 1634299245)'); locked = true;
		await session.query(`CREATE TABLE IF NOT EXISTS treeai_schema_migrations (
			product text NOT NULL, version text NOT NULL, checksum char(64) NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(product,version))`);
		for (const file of [...files].sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
			const version = file.name.slice(0,-4), checksum = createHash('sha256').update(file.sql).digest('hex');
			const existing = await session.query('SELECT checksum FROM treeai_schema_migrations WHERE product=$1 AND version=$2', [product,version]);
			if (existing.rows.length) {
				if (existing.rows.length !== 1 || existing.rows[0]?.checksum !== checksum) throw new Error();
				continue;
			}
			await session.query('BEGIN');
			try {
				await session.query(file.sql);
				await session.query('INSERT INTO treeai_schema_migrations(product,version,checksum) VALUES($1,$2,$3)', [product,version,checksum]);
				await session.query('COMMIT');
			} catch { await session.query('ROLLBACK').catch(() => undefined); throw new Error(); }
		}
	} catch { throw new Error('AI database migration failed; inspect migration custody and checksums'); }
	finally { if (locked) await session.query('SELECT pg_advisory_unlock(1953654116, 1634299245)').catch(() => undefined); }
}
