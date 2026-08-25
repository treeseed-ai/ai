import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

interface Image { repository: string; digest: string }
interface ImageManifest { images: Record<string, Image> }

const release = process.env.TREEAI_COMPONENT_RELEASE;
const sourceCommit = process.env.TREEAI_SOURCE_COMMIT;
const manifestPath = process.env.TREEAI_IMAGE_MANIFEST;
if (!release || !sourceCommit || !manifestPath) throw new Error('Exact release, source commit, and image manifest are required.');
if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Source commit must be an exact Git SHA.');
const revision = Number(process.env.TREEAI_COMPONENT_REVISION ?? '1');
if (!Number.isInteger(revision) || revision < 1) throw new Error('Component revision must be positive.');
const track = release.includes('-rc') ? 'development' : 'stable';
const debianRelease = `${release.replace(/-rc\.?([0-9]+)$/u, '~rc$1')}-${revision}`;
const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8')) as ImageManifest;
const roles = ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations', 'training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations'] as const;
let compose = readFileSync(resolve('deploy/component/compose.template.yml'), 'utf8');
for (const role of roles) {
	const image = manifest.images[role];
	if (!image || !/^treeseed\/[a-z0-9-]+$/u.test(image.repository) || !/^sha256:[a-f0-9]{64}$/u.test(image.digest)) throw new Error(`Missing immutable image ${role}.`);
	compose = compose.replaceAll(`@${role.replaceAll('-', '_').toUpperCase()}_IMAGE@`, `${image.repository}@${image.digest}`);
}
if (/\bbuild\s*:/u.test(compose) || /@[A-Z_]+_IMAGE@/u.test(compose) || /^\s*ports\s*:/mu.test(compose)) throw new Error('Production Compose is not fully immutable and manager-owned.');
const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
const services = [
	{ id: 'inference-migrations', composeService: 'inference-migrations', endpoints: [] },
	{ id: 'inference-vllm', composeService: 'inference-vllm', endpoints: [] },
	{ id: 'inference-evaluator', composeService: 'inference-evaluator', endpoints: [] },
	{ id: 'inference-manager', composeService: 'inference-manager', endpoints: [] },
	{ id: 'inference-api', composeService: 'inference-api', endpoints: [
		{ id: 'control', protocol: 'http', port: 4770, visibility: 'host', defaultAlias: 'inference.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/readyz', timeoutSeconds: 600 } },
		{ id: 'inference', protocol: 'http', port: 4771, visibility: 'private', aliasOverride: false, tls: 'none', authentication: 'application', healthGate: { protocol: 'http', path: '/healthz', timeoutSeconds: 600 } },
	] },
	{ id: 'training-migrations', composeService: 'training-migrations', endpoints: [] },
	{ id: 'training-marker', composeService: 'training-marker', endpoints: [] },
	{ id: 'training-axolotl', composeService: 'training-axolotl', endpoints: [] },
	{ id: 'training-artifact', composeService: 'training-artifact', endpoints: [] },
	{ id: 'training-manager', composeService: 'training-manager', endpoints: [] },
	{ id: 'training-api', composeService: 'training-api', endpoints: [{ id: 'control', protocol: 'http', port: 4780, visibility: 'host', defaultAlias: 'training.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/readyz', timeoutSeconds: 600 } }] },
];
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const,
	componentId: 'ai', version: debianRelease,
	compose: { projectName: 'treeseed-ai', files: [{ path: 'compose.yml', digest: composeDigest }] },
	services,
	stateVolumes: [
		{ id: 'inference', volume: '/var/lib/treeseed/components/ai/inference', backup: 'required' as const },
		{ id: 'training', volume: '/var/lib/treeseed/components/ai/training', backup: 'required' as const },
		{ id: 'archive', volume: '/var/lib/treeseed/components/ai/archive', backup: 'required' as const },
		{ id: 'models', volume: '/var/lib/treeseed/components/ai/models', backup: 'optional' as const },
	],
	migrations: [{ id: 'inference-database', order: 0, backupRequired: true }, { id: 'training-database', order: 1, backupRequired: true }],
	requiredCapabilities: ['docker-compose', 'nvidia-container-runtime'], dependencies: [],
};
const tagUrl = (repository: string) => `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
const bundle = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'ai', release: debianRelease, applicationVersion: release, revision, track,
	source: { repository: 'treeseed-ai/ai', commit: sourceCommit },
	stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
	packages: [{ name: 'treeseed-component-ai', version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: 50 }],
	images: roles.map((role) => ({ role, repository: manifest.images[role]!.repository, digest: manifest.images[role]!.digest, platforms: ['linux/amd64'], consumers: ['ai'] })),
	runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
	evidence: { provenance: roles.map((role) => tagUrl(manifest.images[role]!.repository)), sboms: roles.map((role) => tagUrl(manifest.images[role]!.repository)), vulnerabilities: [] },
});
const output = resolve(process.env.TREEAI_COMPONENT_OUTPUT ?? 'release-assets/component');
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'compose.yml'), compose);
writeFileSync(resolve(output, 'component-release.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, release, debianRelease, runtimeDigest: bundle.runtimeDigest, composeDigest }));
