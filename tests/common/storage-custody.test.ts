import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { aiStorageProofMessage } from '@treeseed/sdk/deployment';
import { managedStorageCustody, type StorageIdentity } from '../../packages/common/src/artifacts/custody.js';

const keys = generateKeyPairSync('ed25519');
const identity: StorageIdentity = {
	url: 'https://api.treeseed.localhost/v1/internal/ai/storage/credentials',
	teamId: '00000000-0000-4000-8000-000000000001', projectId: '00000000-0000-4000-8000-000000000002',
	nodeId: '00000000-0000-4000-8000-000000000003', service: 'training', privateKey: keys.privateKey,
};
function fixture(change: (value: any) => void = () => undefined) {
	return vi.fn(async (_url: any, init: any) => {
		const { proof, signature } = JSON.parse(init.body);
		expect(verify(null, Buffer.from(aiStorageProofMessage(proof)), keys.publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
		const prefix = `teams/${identity.teamId}/projects/${identity.projectId}/ai/v1/nodes/${identity.nodeId}/${proof.storeId}/`;
		const result = { endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`, bucket: 'test-storage', prefix,
			objectKey: prefix + proof.key, expiresAt: new Date(Date.now() + 60_000).toISOString(),
			credentials: { accessKeyId: 'b'.repeat(32), secretAccessKey: 'c'.repeat(64), sessionToken: 'ephemeral-test-token' } };
		change(result); return Response.json({ ok: true, result });
	});
}
describe('managed AI storage custody', () => {
	it('signs fresh scoped proofs and never sends provider credentials', async () => {
		const transport = fixture(), custody = managedStorageCustody(identity, transport);
		await custody('managed-training', 'read', 'datasets/example'); await custody('managed-training', 'write', 'datasets/example');
		const requests = transport.mock.calls.map(([, init]) => JSON.parse(init.body));
		expect(requests[0].proof.nonce).not.toBe(requests[1].proof.nonce);
		expect(requests.map(value => value.proof.action)).toEqual(['read', 'write']);
		expect(JSON.stringify(requests)).not.toMatch(/secretAccessKey|sessionToken|apiToken/u);
		expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error', method: 'POST' });
	});
	it.each(['../escape', 'other//object', '%2e%2e/key', 'key?query', 'key#fragment', 'key\\escape'])('rejects unsafe key %s before network access', async key => {
		const transport = fixture(); await expect(managedStorageCustody(identity, transport)('managed-training', 'read', key)).rejects.toThrow('unavailable');
		expect(transport).not.toHaveBeenCalled();
	});
	it.each([
		(value: any) => { value.endpoint = 'https://attacker.example'; },
		(value: any) => { value.prefix = 'teams/another-team/'; },
		(value: any) => { value.objectKey += '/other'; },
		(value: any) => { value.expiresAt = new Date(Date.now() - 1000).toISOString(); },
		(value: any) => { value.expiresAt = new Date(Date.now() + 3600_000).toISOString(); },
		(value: any) => { delete value.credentials.sessionToken; },
	])('rejects invalid or overbroad broker responses', async change => {
		await expect(managedStorageCustody(identity, fixture(change))('managed-training', 'read', 'item')).rejects.toThrow('unavailable');
	});
	it('redacts network and provider errors', async () => {
		const transport = vi.fn(async () => { throw new Error('secret token should never escape'); });
		await expect(managedStorageCustody(identity, transport)('managed-training', 'list', '')).rejects.toThrow(/^Managed artifact storage access is unavailable/);
	});
	it('bounds response size', async () => {
		const transport = vi.fn(async () => new Response('x'.repeat(20_000)));
		await expect(managedStorageCustody(identity, transport)('managed-training', 'list', '')).rejects.toThrow('unavailable');
	});
	it.each(['http://api.example/v1/internal/ai/storage/credentials', 'https://user:secret@api.example/v1/internal/ai/storage/credentials', 'https://api.example/other'])('rejects unsafe broker configuration', url => {
		expect(() => managedStorageCustody({ ...identity, url })).toThrow('unavailable');
	});
});
