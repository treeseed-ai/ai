import {
	FilesystemArtifactRepository,
	R2ArtifactRepository,
	type ArtifactRepository,
} from '@ai-platform/common';
import { readFileSync } from 'node:fs';

interface CommonStoreConfiguration {
	storeId: string;
	legacyBuckets?: string[];
}

interface FilesystemStoreConfiguration extends CommonStoreConfiguration {
	backend: 'filesystem';
	root: string;
}

interface R2StoreConfiguration extends CommonStoreConfiguration {
	backend: 'r2';
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

export type ArtifactStoreConfiguration = FilesystemStoreConfiguration | R2StoreConfiguration;
export interface ArtifactSourceConfiguration {
	sourceId: string;
	store: ArtifactStoreConfiguration;
	trustedPublicKey: string;
}

function record(path: string) {
	const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Artifact repository configuration must be an object.');
	return value as Record<string, unknown>;
}

function strings(value: unknown) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('Artifact legacy buckets must be strings.');
	return value;
}

export function parseStore(value: unknown): ArtifactStoreConfiguration {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Artifact store configuration must be an object.');
	const input = value as Record<string, unknown>, storeId = input.storeId, backend = input.backend;
	if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(storeId)) throw new Error('Artifact store ID is invalid.');
	const legacyBuckets = strings(input.legacyBuckets);
	if (backend === 'filesystem') {
		if (typeof input.root !== 'string' || !input.root.startsWith('/')) throw new Error('Filesystem artifact root must be absolute.');
		return { backend, storeId, root: input.root, legacyBuckets };
	}
	if (backend === 'r2') {
		if (![input.endpoint, input.bucket, input.accessKeyId, input.secretAccessKey].every((item) => typeof item === 'string' && item.length > 0)) throw new Error('R2 artifact configuration is incomplete.');
		const endpoint = new URL(input.endpoint as string);
		if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('R2 endpoint must be an HTTPS origin.');
		return { backend, storeId, endpoint: endpoint.href, bucket: input.bucket as string, accessKeyId: input.accessKeyId as string, secretAccessKey: input.secretAccessKey as string, legacyBuckets };
	}
	throw new Error('Artifact backend must be filesystem or r2.');
}

export function repository(configuration: ArtifactStoreConfiguration): ArtifactRepository {
	if (configuration.backend === 'filesystem') return new FilesystemArtifactRepository(configuration.storeId, configuration.root, configuration.legacyBuckets);
	return new R2ArtifactRepository(configuration.storeId, configuration.bucket, { endpoint: configuration.endpoint, credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } }, configuration.legacyBuckets);
}

export function sourceConfiguration(path = process.env.ARTIFACT_SOURCE_REGISTRY): ArtifactSourceConfiguration {
	if (!path) throw new Error('ARTIFACT_SOURCE_REGISTRY is required.');
	const value = record(path);
	if (typeof value.sourceId !== 'string' || !value.sourceId || typeof value.trustedPublicKey !== 'string' || !value.trustedPublicKey.includes('PUBLIC KEY')) throw new Error('Artifact source identity or trust key is invalid.');
	return { sourceId: value.sourceId, trustedPublicKey: value.trustedPublicKey, store: parseStore(value.store) };
}

export function destinationConfiguration(path = process.env.ARTIFACT_DESTINATION_REGISTRY): ArtifactStoreConfiguration {
	if (!path) throw new Error('ARTIFACT_DESTINATION_REGISTRY is required.');
	return parseStore(record(path));
}
