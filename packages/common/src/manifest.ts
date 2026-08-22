import { createHash,sign,verify,type KeyLike } from 'node:crypto';
import type { ArtifactManifest } from './types.js';

export function sha256(value: Uint8Array | string) { return createHash('sha256').update(value).digest('hex'); }

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
	return JSON.stringify(value);
}

export function unsignedManifest(manifest: ArtifactManifest) {
	const { signature: _signature,...unsigned } = manifest;
	return Buffer.from(canonical(unsigned));
}

export function signManifest(manifest: Omit<ArtifactManifest, 'signature'>, privateKey: KeyLike): ArtifactManifest {
	const draft = { ...manifest, signature: '' } as ArtifactManifest;
	return { ...draft, signature: sign(null, unsignedManifest(draft), privateKey).toString('base64') };
}

export function verifyManifest(manifest: ArtifactManifest, publicKey: KeyLike) {
	return manifest.schemaVersion === 'ai.artifact/v1' && verify(null, unsignedManifest(manifest), publicKey, Buffer.from(manifest.signature, 'base64'));
}
