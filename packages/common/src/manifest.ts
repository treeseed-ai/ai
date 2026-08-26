import { createHash,sign,verify,type KeyLike } from 'node:crypto';
import type { ArtifactManifest } from './types.js';

export function sha256(value: Uint8Array | string) { return createHash('sha256').update(value).digest('hex'); }

function legacyCanonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${legacyCanonical(entry)}`).join(',')}}`;
	return JSON.stringify(value);
}

function numberToken(value: number) {
	if (!Number.isFinite(value)) throw new Error('Signed JSON cannot contain non-finite numbers.');
	if (Object.is(value,-0)) return '0';
	if (Number.isInteger(value)) return String(value);
	const [rawMantissa,rawExponent] = value.toPrecision(17).toLowerCase().split('e');
	const mantissa = rawMantissa!.replace(/(\.\d*?[1-9])0+$/u,'$1').replace(/\.0+$/u,'');
	return rawExponent === undefined ? mantissa : `${mantissa}e${Number(rawExponent)}`;
}

function canonical(value: unknown): string {
	if (value === null) return 'n';
	if (typeof value === 'boolean') return value ? 'b1' : 'b0';
	if (typeof value === 'number') return `d${numberToken(value)}`;
	if (typeof value === 'string') return `s${JSON.stringify(value)}`;
	if (Array.isArray(value)) return `a[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') return `o{${Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,entry])=>`${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
	throw new Error('Signed JSON contains an unsupported value.');
}

export function unsignedManifest(manifest: ArtifactManifest) {
	const { signature: _signature,...unsigned } = manifest;
	return Buffer.from(`treeai-canonical-v2\n${canonical(unsigned)}`);
}

function legacyUnsignedManifest(manifest: ArtifactManifest) { const {signature:_signature,...unsigned}=manifest;return Buffer.from(legacyCanonical(unsigned)); }

export function signManifest(manifest: Omit<ArtifactManifest, 'signature'>, privateKey: KeyLike): ArtifactManifest {
	const draft = { ...manifest, signature: '' } as ArtifactManifest;
	return { ...draft, signature: sign(null, unsignedManifest(draft), privateKey).toString('base64') };
}

export function verifyManifest(manifest: ArtifactManifest, publicKey: KeyLike) {
	if(!['ai.artifact/v1','ai.artifact/v2','ai.artifact/v3'].includes(manifest.schemaVersion))return false;
	const signature=Buffer.from(manifest.signature,'base64');
	return verify(null,unsignedManifest(manifest),publicKey,signature)||verify(null,legacyUnsignedManifest(manifest),publicKey,signature);
}
