import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { readAiDatabaseUrl } from '../../packages/common/src/database/connection.js';
import { applyAiMigrations } from '../../packages/common/src/database/migrations.js';

async function main() {
	const product = process.env.TREEAI_MIGRATION_PRODUCT;
	if (product !== 'inference' && product !== 'training') throw new Error();
	const client = new pg.Client({ connectionString: readAiDatabaseUrl(product), connectionTimeoutMillis: 10000,
		statement_timeout: 600000, lock_timeout: 5000, application_name: `treeseed-ai-${product}-migration` });
	client.on('error', () => { process.exitCode = 1; });
	try {
		await client.connect();
		const phase = await client.query('SELECT current_user<>session_user AS migration');
		if (phase.rows[0]?.migration !== true) throw new Error();
		const files = readdirSync('/migrations').map(name => {
			if (!/^[0-9]+_[a-z0-9_-]+\.sql$/u.test(name)) throw new Error();
			return { name, sql: readFileSync(`/migrations/${name}`, 'utf8') };
		});
		await applyAiMigrations(client, product, files);
	} finally { await client.end().catch(() => undefined); }
}
await main().catch(() => { console.error('Managed AI database migration failed'); process.exitCode = 1; });
