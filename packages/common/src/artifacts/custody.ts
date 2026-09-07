import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { aiStorageProofMessage, aiStorageProofSchema, type AiStorageProof } from '@treeseed/sdk/deployment';

export type StorageAction = AiStorageProof['action'];
export interface StorageLease {
	endpoint: string; bucket: string; prefix: string; objectKey: string; expiresAt: string;
	credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
}
export type StorageCustody = (storeId: string, action: StorageAction, key: string) => Promise<StorageLease>;
export interface StorageIdentity {
	url: string; teamId: string; projectId: string; nodeId: string;
	service: AiStorageProof['service']; privateKey: KeyObject;
}
const unavailable = () => new Error('Managed artifact storage access is unavailable. Check the service connection and node binding.');

/** No provider credentials are accepted in configuration or retained between operations. */
export function managedStorageCustody(identity: StorageIdentity, fetchImpl: typeof fetch = fetch): StorageCustody {
	const url = new URL(identity.url);
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
		|| url.pathname !== '/v1/internal/ai/storage/credentials' || identity.privateKey.asymmetricKeyType !== 'ed25519') throw unavailable();
	return async (storeId, action, key) => {
		try {
			const proof = aiStorageProofSchema.parse({ schemaVersion: 'treeseed.ai-storage-proof/v1',
				teamId: identity.teamId, projectId: identity.projectId, nodeId: identity.nodeId, service: identity.service,
				storeId, action, key, issuedAt: Math.floor(Date.now() / 1000), nonce: randomUUID() });
			const signature = sign(null, Buffer.from(aiStorageProofMessage(proof)), identity.privateKey).toString('base64url');
			const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
				headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof, signature }) });
			if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable(); }
			const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
			let result: unknown;
			try {
				for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16_384) throw unavailable(); chunks.push(value); }
				const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				if (body.ok !== true) throw unavailable(); result = body.result;
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
			return validateStorageLease(result, proof);
		} catch { throw unavailable(); }
	};
}

export function validateStorageLease(value: unknown, proof: AiStorageProof): StorageLease {
	const lease = value as StorageLease | undefined;
	const prefix = `teams/${proof.teamId}/projects/${proof.projectId}/ai/v1/nodes/${proof.nodeId}/${proof.storeId}/`;
	if (!lease || !/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(lease.endpoint)
		|| !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(lease.bucket) || lease.prefix !== prefix || lease.objectKey !== `${prefix}${proof.key}`
		|| !Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= Date.now() + 1000
		|| Date.parse(lease.expiresAt) > Date.now() + 65_000 || !lease.credentials
		|| !/^[a-f0-9]{32}$/u.test(lease.credentials.accessKeyId) || !/^[a-f0-9]{64}$/u.test(lease.credentials.secretAccessKey)
		|| typeof lease.credentials.sessionToken !== 'string' || lease.credentials.sessionToken.length > 8192 || !lease.credentials.sessionToken) throw unavailable();
	return lease;
}

export function storageCustodyFromEnvironment(env = process.env): StorageCustody {
	try {
		const service = env.AI_STORAGE_SERVICE;
		if (service !== 'inference' && service !== 'training' && service !== 'lab') throw unavailable();
		const bytes = readFileSync(`/run/secrets/ai-${service}-storage-identity`);
		try {
			return managedStorageCustody({ url: env.AI_STORAGE_URL!, teamId: env.AI_TEAM_ID!, projectId: env.AI_PROJECT_ID!,
				nodeId: env.AI_NODE_ID!, service, privateKey: createPrivateKey(bytes) });
		} finally { bytes.fill(0); }
	} catch { throw unavailable(); }
}
