import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { destinationConfiguration, repository, sourceConfiguration } from '../../packages/inference-api/src/artifact-storage.js';
import { verifyArtifactDestination, verifyArtifactSource } from '../../packages/inference-api/src/artifacts.js';

const priorSource = process.env.ARTIFACT_SOURCE_REGISTRY, priorDestination = process.env.ARTIFACT_DESTINATION_REGISTRY;
afterEach(() => {
	if (priorSource) process.env.ARTIFACT_SOURCE_REGISTRY = priorSource; else delete process.env.ARTIFACT_SOURCE_REGISTRY;
	if (priorDestination) process.env.ARTIFACT_DESTINATION_REGISTRY = priorDestination; else delete process.env.ARTIFACT_DESTINATION_REGISTRY;
});

function trust() {
	return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

it('verifies the local signed source and durable inference destination', async () => {
	const root = mkdtempSync(join(tmpdir(), 'treeai-artifact-exchange-')), training = join(root, 'training'), inference = join(root, 'inference');
	const sourcePath = join(root, 'source.json'), destinationPath = join(root, 'destination.json');
	writeFileSync(sourcePath, JSON.stringify({ sourceId: 'training-local', trustedPublicKey: trust(), store: { backend: 'filesystem', storeId: 'training', root: training } }));
	writeFileSync(destinationPath, JSON.stringify({ backend: 'filesystem', storeId: 'inference', root: inference }));
	process.env.ARTIFACT_SOURCE_REGISTRY = sourcePath; process.env.ARTIFACT_DESTINATION_REGISTRY = destinationPath;
	const input = repository(sourceConfiguration().store); await input.put('manifests/example.json', new TextEncoder().encode('{}'));
	await expect(verifyArtifactSource()).resolves.toBeUndefined();
	await expect(verifyArtifactDestination()).resolves.toBeUndefined();
	expect(Buffer.from(await repository(destinationConfiguration()).bytes('artifact://inference/_health/artifact-readiness-v2')).toString()).toBe('treeai-artifact-readiness-v2');
});

it('accepts only managed R2 descriptors and rejects embedded credentials', () => {
 const root=mkdtempSync(join(tmpdir(),'treeai-artifact-r2-')),path=join(root,'destination.json');
 process.env.ARTIFACT_DESTINATION_REGISTRY=path;
 writeFileSync(path,JSON.stringify({backend:'r2',storeId:'managed-inference'}));
 expect(destinationConfiguration()).toEqual({backend:'r2',storeId:'managed-inference'});
 for(const extra of [{endpoint:'https://example.invalid'},{accessKeyId:'access',secretAccessKey:'secret'},{legacyBuckets:['old']}]) {
  writeFileSync(path,JSON.stringify({backend:'r2',storeId:'managed-inference',...extra}));
  expect(()=>destinationConfiguration()).toThrow('unsupported fields');
 }
});

it('rejects cross-store artifact access before reading bytes', async () => {
	const root = mkdtempSync(join(tmpdir(), 'treeai-artifact-boundary-')), store = repository({ backend: 'filesystem', storeId: 'training', root });
	await expect(store.bytes('artifact://inference/object')).rejects.toThrow(/different store/u);
});
