import {
	FilesystemArtifactRepository,
	R2ArtifactRepository,
	storageCustodyFromEnvironment,
	type ArtifactRepository,
} from '@ai-platform/common';
import { readFileSync } from 'node:fs';

interface CommonStoreConfiguration {
	storeId: string;
}

interface FilesystemStoreConfiguration extends CommonStoreConfiguration {
	backend: 'filesystem';
	root: string;
}

interface R2StoreConfiguration extends CommonStoreConfiguration {
	backend: 'r2';
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

export function parseStore(value: unknown): ArtifactStoreConfiguration {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Artifact store configuration must be an object.');
	const input = value as Record<string, unknown>, storeId = input.storeId, backend = input.backend;
	if (typeof storeId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(storeId)) throw new Error('Artifact store ID is invalid.');
	const allowed = backend === 'filesystem' ? ['backend', 'storeId', 'root'] : ['backend', 'storeId'];
	if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Artifact store configuration contains unsupported fields.');
	if (backend === 'filesystem') {
		if (typeof input.root !== 'string' || !input.root.startsWith('/')) throw new Error('Filesystem artifact root must be absolute.');
		return { backend, storeId, root: input.root };
	}
	if (backend === 'r2') {
		if (!['managed-inference', 'managed-training'].includes(storeId)) throw new Error('R2 storage requires a managed AI allocation.');
		return { backend, storeId };
	}
	throw new Error('Artifact backend must be filesystem or r2.');
}

export function repository(configuration: ArtifactStoreConfiguration): ArtifactRepository {
	if (configuration.backend === 'filesystem') return new FilesystemArtifactRepository(configuration.storeId, configuration.root);
	return new R2ArtifactRepository(configuration.storeId, storageCustodyFromEnvironment());
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
