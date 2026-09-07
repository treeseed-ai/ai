import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configuredDelegationTrust, verifyDelegation } from '../../packages/common/src/auth/delegation.js';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const trust = { issuer: 'https://control.invalid/ai', audience: 'treeai:node', teamId: 'team', nodeId: 'node', publicKeys: [publicKey] };
function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
	const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
	const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT', kid: 'fixture', ...header })}.${encoded({ iss: trust.issuer, aud: trust.audience, sub: 'actor', teamId: 'team', nodeId: 'node', scopes: ['inference:invoke'], iat: 1000, exp: 1060, jti: 'request', ...overrides })}`;
	return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), pair.privateKey).toString('base64url')}`;
}
describe('bounded control-plane delegation', () => {
	it('accepts exact trusted identity and operation scopes', () => {
		expect(verifyDelegation(token(), trust, 1001)).toEqual({ id: 'actor', teamId: 'team', nodeId: 'node', scopes: ['inference:invoke'] });
	});
	it('rejects cross-team/node, wrong issuer/audience, expired and oversized grants', () => {
		for (const value of [{ teamId: 'other' }, { nodeId: 'other' }, { iss: 'other' }, { aud: 'other' }, { exp: 1001 }, { exp: 1200 }, { iat: 1010 }, { scopes: ['*'] }])
			expect(() => verifyDelegation(token(value), trust, 1001)).toThrow(/invalid or expired/);
		for (const header of [{ alg: 'HS256' }, { kid: 'other' }, { jku: 'https://attacker.invalid' }])
			expect(() => verifyDelegation(token({}, header), trust, 1001)).toThrow(/invalid or expired/);
	});
	it('fails closed on partial installed trust and private-key input', () => {
		expect(configuredDelegationTrust({})).toBeNull();
		expect(() => configuredDelegationTrust({ AI_TEAM_ID: 'team' })).toThrow(/incomplete/);
		expect(() => configuredDelegationTrust({ AI_TEAM_ID: 'team', AI_NODE_ID: 'node', AI_DELEGATION_ISSUER: trust.issuer, AI_DELEGATION_AUDIENCE: trust.audience,
			AI_DELEGATION_PUBLIC_KEYS: JSON.stringify([{ ...publicKey, d: 'private' }]) })).toThrow(/invalid/);
	});
});
