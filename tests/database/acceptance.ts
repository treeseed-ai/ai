import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || process.getuid?.() !== 0) throw new Error('Disposable Actions acceptance required');
const prefix = `treeseed-ai-pg-${randomBytes(8).toString('hex')}`, root = mkdtempSync(join(tmpdir(), prefix));
const server = `${prefix}-postgres`, network = `${prefix}-private`;
const image = 'postgres:17.11-bookworm@sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0';
const password = randomBytes(32).toString('base64url');
const owned = new Set([server]); let networkCreated = false, stage = 'setup';
const docker = (args: string[], timeout = 180000) => execFileSync('/usr/bin/docker', args,
	{ encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout, maxBuffer: 1048576 });
const sql = (database: string, query: string) => docker(['exec',server,'psql','-X','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At','-c',query]).trim();
try {
	const tls = join(root,'tls'); mkdirSync(tls, { mode: 0o755 });
	execFileSync('/usr/bin/openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=postgres',
		'-addext','subjectAltName=DNS:postgres','-keyout',join(tls,'key.pem'),'-out',join(tls,'ca.pem')], { stdio: 'ignore' });
	const uid = Number(docker(['run','--rm','--network','none',image,'id','-u','postgres']));
	assert.ok(Number.isInteger(uid) && uid > 0); chownSync(join(tls,'key.pem'),uid,uid); chmodSync(join(tls,'key.pem'),0o600);
	writeFileSync(join(tls,'hba.conf'),'local all all trust\nhostssl all all all scram-sha-256\nhost all all all reject\n');
	docker(['network','create','--internal','--label','org.treeseed.test=ai-postgres',network]); networkCreated = true;
	docker(['run','-d','--name',server,'--network',network,'--network-alias','postgres','--tmpfs','/var/lib/postgresql/data',
		'--mount',`type=bind,source=${tls},target=/tls,readonly`,'-e',`POSTGRES_PASSWORD=${password}`,image,
		'-c','ssl=on','-c','ssl_cert_file=/tls/ca.pem','-c','ssl_key_file=/tls/key.pem','-c','hba_file=/tls/hba.conf']);
	let ready = false;
	for (let attempt=0;attempt<60;attempt++) {
		try { sql('postgres','SELECT 1'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve,1000)); }
	}
	assert.ok(ready);
	for (const product of ['inference','training'] as const) {
		stage = `${product}-image`;
		const tag = `${prefix}-${product}`, uid = product === 'inference' ? 1000 : 10001;
		docker(['build','-q','-t',tag,'-f',`containers/${product}/migrations.Dockerfile`,'.'],600000);
		stage = `${product}-allocation`;
		sql('postgres',`CREATE ROLE ${product}_owner NOLOGIN; CREATE ROLE ${product}_migration LOGIN PASSWORD '${password}';
			CREATE ROLE ${product}_runtime NOLOGIN PASSWORD '${password}'; GRANT ${product}_owner TO ${product}_migration;
			ALTER ROLE ${product}_migration SET role='${product}_owner';`);
		sql('postgres',`CREATE DATABASE ${product} OWNER ${product}_owner`);
		sql('postgres',`REVOKE ALL ON DATABASE ${product} FROM PUBLIC; GRANT CONNECT ON DATABASE ${product} TO ${product}_migration,${product}_runtime`);
		const mount = `/run/treeseed/postgres/ai-${product}`, files = join(root,product); mkdirSync(files,{mode:0o755});
		const writeBinding = (role: string) => {
			writeFileSync(join(files,'url'),`postgresql://${product}_${role}:${password}@postgres:5432/${product}?sslmode=verify-full&sslrootcert=${mount}/ca.pem`,{mode:0o400});
			chownSync(join(files,'url'),uid,uid);
		};
		writeFileSync(join(files,'ca.pem'),readFileSync(join(tls,'ca.pem'))); writeBinding('migration');
		const name = `${prefix}-${product}-job`; owned.add(name);
		const args = ['run','--rm','--name',name,'--network',network,'--mount',`type=bind,source=${files},target=${mount},readonly`,
			'-e',`TREESEED_DATABASE_URL_FILE=${mount}/url`];
		stage = `${product}-migration`;
		docker([...args,tag]);
		const before = sql(product,'SELECT count(*) FROM treeai_schema_migrations');
		docker([...args,tag]); assert.equal(sql(product,'SELECT count(*) FROM treeai_schema_migrations'),before);
		assert.equal(sql(product,"SELECT bool_and(pg_get_userbyid(c.relowner)=current_database()||'_owner') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'"),'t');
		sql('postgres',`ALTER ROLE ${product}_migration NOLOGIN; ALTER ROLE ${product}_runtime LOGIN`);
		sql(product,`GRANT USAGE ON SCHEMA public TO ${product}_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${product}_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${product}_runtime`);
		writeBinding('runtime');
		// Runtime can neither replay migrations nor acquire owner privileges.
		assert.throws(() => docker([...args,tag]));
		writeFileSync(join(files,'probe.mjs'),readFileSync(resolve('tests/database/runtime-probe.mjs')));
	}
	for (const product of ['inference','training']) {
		stage = `${product}-runtime-isolation`;
		const mount = `/run/treeseed/postgres/ai-${product}`, name = `${prefix}-${product}-probe`; owned.add(name);
		docker(['run','--rm','--name',name,'--network',network,'--mount',`type=bind,source=${join(root,product)},target=${mount},readonly`,
			'-e',`TREESEED_DATABASE_URL_FILE=${mount}/url`,'--entrypoint','node',`${prefix}-${product}`,`${mount}/probe.mjs`]);
	}
	console.log(JSON.stringify({ok:true,checks:['separate-owned-databases','verified-tls','restricted-migrations','checksum-replay-noop','runtime-ddl-denied','cross-database-connect-denied']}));
} catch { console.error(JSON.stringify({ok:false,stage})); process.exitCode=1; }
finally {
	for (const name of owned) { try { docker(['rm','-f',name]); } catch { /* exact disposable ownership only */ } }
	if (networkCreated) { try { docker(['network','rm',network]); } catch { /* exact disposable network only */ } }
	rmSync(root,{recursive:true,force:true});
}
