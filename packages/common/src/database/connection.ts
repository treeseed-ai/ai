import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export type AiDatabase = 'inference' | 'training';

/** Deployment owns this phase-specific, read-only credential mount. No ambient
 * connection URL, bootstrap credential, or fallback after an invalid binding.
 */
export function readAiDatabaseUrl(product: AiDatabase, env = process.env): string {
	const path = `/run/treeseed/postgres/ai-${product}/url`;
	let descriptor: number | undefined, bytes: Buffer | undefined;
	try {
		if (!['inference', 'training'].includes(product) || env.TREESEED_DATABASE_URL_FILE !== path || env.DATABASE_URL) throw new Error();
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size < 1 || stat.size > 16384) throw new Error();
		bytes = readFileSync(descriptor);
		return validateAiDatabaseUrl(bytes.toString('utf8'), product);
	} catch { throw new Error('Managed AI database binding is unavailable or unsafe'); }
	finally { bytes?.fill(0); if (descriptor !== undefined) closeSync(descriptor); }
}

export function validateAiDatabaseUrl(value: string, product: AiDatabase): string {
	try {
		const url = new URL(value);
		if (!['inference','training'].includes(product) || url.protocol !== 'postgresql:' || !url.hostname || !url.username ||
			url.username === 'postgres' || !url.password || url.hash || !/^\/[a-z][a-z0-9_]{0,62}$/u.test(url.pathname) ||
			url.searchParams.get('sslmode') !== 'verify-full' ||
			url.searchParams.get('sslrootcert') !== `/run/treeseed/postgres/ai-${product}/ca.pem` ||
			[...url.searchParams.keys()].some(key => !['sslmode','sslrootcert'].includes(key)) || [...url.searchParams].length !== 2) throw new Error();
		return value;
	} catch { throw new Error('Invalid managed AI database binding'); }
}
