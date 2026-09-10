import assert from 'node:assert/strict';
import pg from 'pg';
import { readAiDatabaseUrl } from '../../packages/common/src/database/connection.js';

const product = process.env.TREEAI_MIGRATION_PRODUCT;
if (product !== 'inference' && product !== 'training') throw new Error('Fixture product required');
const client = new pg.Client({ connectionString: readAiDatabaseUrl(product), connectionTimeoutMillis: 10000 });
try {
	await client.connect();
	assert.equal((await client.query('SELECT count(*)::int AS count FROM treeai_schema_migrations')).rows[0].count, product === 'inference' ? 2 : 6);
	assert.equal((await client.query('SELECT count(*)::int AS count FROM jobs')).rows[0].count, 0);
	for (const sql of ['CREATE TABLE forbidden(id integer)', 'SET ROLE postgres', `SET ROLE ${product}_owner`]) {
		await assert.rejects(client.query(sql));
	}
	const other = product === 'inference' ? 'training' : 'inference';
	assert.equal((await client.query('SELECT has_database_privilege(current_user,$1,\'CONNECT\') AS allowed', [other])).rows[0].allowed, false);
} finally { await client.end(); }
