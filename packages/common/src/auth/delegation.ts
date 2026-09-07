import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export interface DelegatedPrincipal { id: string; teamId: string; nodeId: string; scopes: string[] }
export interface DelegationTrust { issuer: string; audience: string; teamId: string; nodeId: string; publicKeys: JsonWebKey[] }

/** Verify an operation-scoped control-plane delegation against explicitly installed public trust. */
export function verifyDelegation(token: string, trust: DelegationTrust, now = Math.floor(Date.now() / 1000)): DelegatedPrincipal {
	try {
		if (token.length > 16_384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) throw new Error();
		const [headerText, claimsText, signature] = token.split('.') as [string, string, string];
		const header = JSON.parse(Buffer.from(headerText, 'base64url').toString('utf8'));
		const claims = JSON.parse(Buffer.from(claimsText, 'base64url').toString('utf8'));
		if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) throw new Error();
		const keys = trust.publicKeys.filter(key => key && key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig' && !key.d);
		if (keys.length !== 1 || !verify('RSA-SHA256', Buffer.from(`${headerText}.${claimsText}`), createPublicKey({ key: keys[0]!, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
		if (!trust.issuer || !trust.audience || !trust.teamId || !trust.nodeId || claims.iss !== trust.issuer || claims.aud !== trust.audience
			|| claims.teamId !== trust.teamId || claims.nodeId !== trust.nodeId || typeof claims.sub !== 'string' || !claims.sub
			|| typeof claims.jti !== 'string' || !claims.jti || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
			|| claims.iat > now + 5 || claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 120
			|| !Array.isArray(claims.scopes) || claims.scopes.length > 32
			|| claims.scopes.some((scope: unknown) => typeof scope !== 'string' || !/^[a-z][a-z-]+(?::[a-z][a-z-]+)+$/u.test(scope))) throw new Error();
		return { id: claims.sub, teamId: claims.teamId, nodeId: claims.nodeId, scopes: [...new Set(claims.scopes)] as string[] };
	} catch { throw new Error('Control-plane delegation is invalid or expired.'); }
}

export function configuredDelegationTrust(env = process.env): DelegationTrust | null {
	const keys = ['AI_DELEGATION_ISSUER', 'AI_DELEGATION_AUDIENCE', 'AI_TEAM_ID', 'AI_NODE_ID', 'AI_DELEGATION_PUBLIC_KEYS'] as const;
	if (!keys.some(key => env[key] !== undefined)) return null;
	if (keys.some(key => !env[key]?.trim())) throw new Error('AI control-plane trust configuration is incomplete.');
	let publicKeys: JsonWebKey[];
	try { publicKeys = JSON.parse(env.AI_DELEGATION_PUBLIC_KEYS!); } catch { throw new Error('AI delegation public keys are invalid.'); }
	if (!Array.isArray(publicKeys) || !publicKeys.length || publicKeys.length > 8 || publicKeys.some(key => !key || key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || !key.kid || key.d)) throw new Error('AI delegation public keys are invalid.');
	return { issuer: env.AI_DELEGATION_ISSUER!, audience: env.AI_DELEGATION_AUDIENCE!, teamId: env.AI_TEAM_ID!, nodeId: env.AI_NODE_ID!, publicKeys };
}
