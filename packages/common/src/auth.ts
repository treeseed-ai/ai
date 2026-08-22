import { randomBytes,scryptSync,timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Pool } from 'pg';

export interface ApiKeyRecord { id: string; hash: string; scopes: string[]; revoked: boolean }
export type ApiKeyResolver = (id: string) => Promise<ApiKeyRecord | null>;

export function postgresApiKeyResolver(pool: Pool, bootstrap: ApiKeyRecord[] = []): ApiKeyResolver {
	return async (id) => {
		const fallback=bootstrap.find((entry)=>entry.id===id)??null;
		try { const result=await pool.query('SELECT id,hash,scopes,revoked FROM api_keys WHERE id=$1',[id]); return result.rowCount ? result.rows[0] as ApiKeyRecord : fallback; }
		catch { return fallback; }
	};
}

export function hashApiKey(secret: string, salt = randomBytes(16).toString('hex')) {
	return `scrypt:${salt}:${scryptSync(secret, salt, 32).toString('hex')}`;
}

export function verifyApiKey(secret: string, encoded: string) {
	const [algorithm, salt, expected] = encoded.split(':');
	if (algorithm !== 'scrypt' || !salt || !expected) return false;
	const actual = scryptSync(secret, salt, 32);
	const target = Buffer.from(expected, 'hex');
	return actual.length === target.length && timingSafeEqual(actual, target);
}

export function apiKeyAuthorization(resolve: ApiKeyResolver): MiddlewareHandler {
	return async (context, next) => {
		const requestId = context.req.header('x-request-id') ?? crypto.randomUUID();
		context.header('x-request-id', requestId);
		context.set('requestId' as never,requestId as never);
		const value = context.req.header('authorization')?.match(/^Bearer ak_([^_]+)_(.+)$/u);
		if (!value) return context.json({ error: { code: 'unauthorized', message: 'A valid API key is required.', requestId } }, 401);
		const record = await resolve(value[1]!);
		if (!record || record.revoked || !verifyApiKey(value[2]!, record.hash)) return context.json({ error: { code: 'unauthorized', message: 'The API key is invalid or revoked.', requestId } }, 401);
		context.set('apiKey' as never, record as never);
		await next();
	};
}

export function requireScope(scope: string): MiddlewareHandler {
	return async (context, next) => {
		const record = context.get('apiKey' as never) as ApiKeyRecord | undefined;
		if (!record?.scopes.includes(scope) && !record?.scopes.includes('*')) return context.json({ error: { code: 'forbidden', message: `Scope ${scope} is required.`,requestId:context.get('requestId' as never) } }, 403);
		await next();
	};
}
