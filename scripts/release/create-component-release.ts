import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';
import YAML from 'yaml';

interface Image { repository: string; digest: string }
interface ImageManifest { images: Record<string, Image> }
interface RuntimeImage { id: string; reference: string; digest: string }

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
const output = resolve(process.env.TREEAI_COMPONENT_OUTPUT ?? 'release-assets/component');
mkdirSync(output, { recursive: true });

const definitions = {
	'ai-inference': {
		roles: ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations'],
		services: ['inference-postgres', 'inference-migrations', 'inference-vllm', 'inference-evaluator', 'inference-manager', 'inference-api'],
		states: [
			{ id: 'postgres', volume: '/var/lib/treeseed/components/ai-inference/data/postgres', backup: 'required' },
			{ id: 'inference', volume: '/var/lib/treeseed/components/ai-inference/data/inference', backup: 'required' },
			{ id: 'models', volume: '/var/lib/treeseed/components/ai-inference/data/models', backup: 'optional' },
		],
		configuration: {
			environment: [
				{ name: 'SOURCE_MODEL', required: false, default: 'Qwen/Qwen3.5-4B' },
				{ name: 'SOURCE_MODEL_REVISION', required: false, default: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a' },
				{ name: 'PUBLIC_MODEL', required: false, default: 'local-model' },
				{ name: 'MAX_MODEL_LENGTH', required: false, default: '16384' },
			],
			secretEnvironment: [
				{ name: 'INFERENCE_DATABASE_URL', required: true },
				{ name: 'INFERENCE_POSTGRES_PASSWORD', required: true },
				{ name: 'AI_API_KEYS', required: true },
			],
			secretFiles: [], files: [],
		},
		migrations: [{ id: 'inference-database', order: 0, backupRequired: true }], dependencies: [], order: 50,
	},
	'ai-training': {
		roles: ['training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations'],
		services: ['training-postgres', 'training-migrations', 'training-marker', 'training-axolotl', 'training-artifact', 'training-manager', 'training-api'],
		states: [
			{ id: 'postgres', volume: '/var/lib/treeseed/components/ai-training/data/postgres', backup: 'required' },
			{ id: 'training', volume: '/var/lib/treeseed/components/ai-training/data/training', backup: 'required' },
			{ id: 'archive', volume: '/var/lib/treeseed/components/ai-training/data/archive', backup: 'required' },
			{ id: 'models', volume: '/var/lib/treeseed/components/ai-training/data/models', backup: 'optional' },
		],
		configuration: {
			environment: [
				{ name: 'ARTIFACT_BACKEND', required: false, default: 'filesystem' },
				{ name: 'ARTIFACT_ROOT', required: false, default: '/artifacts' },
			],
			secretEnvironment: [
				{ name: 'TRAINING_DATABASE_URL', required: true },
				{ name: 'TRAINING_POSTGRES_PASSWORD', required: true },
				{ name: 'AI_API_KEYS', required: true },
			],
			secretFiles: [{ id: 'artifact-signing-key', path: '/etc/treeseed/credentials/ai-artifact-signing-key', required: true }], files: [],
		},
		migrations: [{ id: 'training-database', order: 0, backupRequired: true }], dependencies: [], order: 51,
	},
	'ai-lab': {
		roles: ['lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'lab-open-webui', 'hermes-agent', 'lab-web-tool-proxy'],
		services: ['experience-proxy', 'controller', 'library-bridge', 'open-webui', 'open-webui-action-init', 'web-tool-proxy', 'hermes-agent', 'hermes-dashboard'],
		states: [
			{ id: 'state', volume: '/var/lib/treeseed/components/ai-lab/data/state', backup: 'required' },
			{ id: 'hermes', volume: '/var/lib/treeseed/components/ai-lab/data/hermes', backup: 'required' },
			{ id: 'workspace', volume: '/var/lib/treeseed/components/ai-lab/data/workspace', backup: 'required' },
			{ id: 'webui', volume: '/var/lib/treeseed/components/ai-lab/data/open-webui', backup: 'required' },
		],
		configuration: {
			environment: [
				{ name: 'BASE_MODEL_REVISION', required: true, default: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a' },
				{ name: 'RUNTIME_GID', required: true, source: 'manager' },
			],
			secretEnvironment: [{ name: 'AI_LAB_API_KEYS', required: true }],
			secretFiles: [
				{ id: 'training-source', path: '/etc/treeseed/credentials/ai-lab-training-source', required: true },
				{ id: 'factory-control-key', path: '/etc/treeseed/credentials/ai-lab-factory-control-key', required: true },
				{ id: 'factory-inference-key', path: '/etc/treeseed/credentials/ai-lab-factory-inference-key', required: true },
				{ id: 'factory-training-key', path: '/etc/treeseed/credentials/ai-lab-factory-training-key', required: true },
				{ id: 'hermes-api-key', path: '/etc/treeseed/credentials/ai-lab-hermes-api-key', required: true },
				{ id: 'hermes-password-hash', path: '/etc/treeseed/credentials/ai-lab-hermes-password-hash', required: true },
				{ id: 'hermes-session-secret', path: '/etc/treeseed/credentials/ai-lab-hermes-session-secret', required: true },
				{ id: 'training-ingest-key', path: '/etc/treeseed/credentials/ai-lab-training-ingest-key', required: true },
				{ id: 'lab-library-action-key', path: '/etc/treeseed/credentials/ai-lab-lab-library-action-key', required: true },
			],
			files: [],
		},
		migrations: [],
		dependencies: [
			{ id: 'inference', capability: 'treeai-inference-api', locality: 'local', optional: false },
			{ id: 'training', capability: 'treeai-training-api', locality: 'local', optional: false },
		], order: 52,
	},
} as const;

function exactImage(role: string) {
	const image = manifest.images[role];
	if (!image || !/^(?:[a-z0-9.-]+\/)?[a-z0-9-]+\/[a-z0-9-]+$/u.test(image.repository) || !/^sha256:[a-f0-9]{64}$/u.test(image.digest)) throw new Error(`Missing immutable image ${role}.`);
	return `${image.repository}@${image.digest}`;
}

function runtimeImage(id: string): Image {
	const catalog = JSON.parse(readFileSync(resolve('release/catalog.json'), 'utf8')) as { runtimeImages: RuntimeImage[] };
	const selected = catalog.runtimeImages.find((image) => image.id === id);
	if (!selected || !selected.reference.endsWith(`@${selected.digest}`) || !/^sha256:[a-f0-9]{64}$/u.test(selected.digest)) throw new Error(`The ${id} runtime image is not pinned.`);
	return { repository: selected.reference.slice(0, selected.reference.indexOf('@')).replace(/:[^/:]+$/u, ''), digest: selected.digest };
}

function baseCompose(componentId: 'ai-inference' | 'ai-training') {
	const family = componentId === 'ai-inference' ? 'inference' : 'training';
	let source = readFileSync(resolve('deploy/component/compose.template.yml'), 'utf8')
		.replaceAll('/etc/treeseed/components/ai/environment', `/etc/treeseed/components/${componentId}/environment`)
		.replaceAll('/ai/data/', `/${componentId}/data/`);
	const postgres = runtimeImage('postgres');
	source = source.replaceAll('@POSTGRES_IMAGE@', `${postgres.repository}@${postgres.digest}`);
	for (const role of definitions[componentId].roles) source = source.replaceAll(`@${role.replaceAll('-', '_').toUpperCase()}_IMAGE@`, exactImage(role));
	const parsed = YAML.parse(source) as Record<string, any>;
	parsed.name = `treeseed-${componentId}`;
	parsed.services = Object.fromEntries(definitions[componentId].services.map((name) => [name, parsed.services[name]]));
	parsed.networks = Object.fromEntries(Object.entries(parsed.networks).filter(([name]) => name === `${family}-private` || name === 'platform' || name === 'treeseed-edge'));
	if (componentId === 'ai-training') parsed.services['training-api'].volumes = [{ type: 'bind', source: '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-training/data/training', target: '/artifacts' }];
	if (componentId === 'ai-inference') delete parsed.secrets;
	return parsed;
}

function labCompose() {
	const parsed = YAML.parse(readFileSync(resolve('deploy/lab/compose.yml'), 'utf8')) as Record<string, any>;
	const roleByService: Record<string, string> = {
		'experience-proxy': 'lab-experience-proxy', controller: 'lab-controller', 'library-bridge': 'lab-library-bridge',
		'open-webui': 'lab-open-webui', 'open-webui-action-init': 'lab-open-webui',
		'web-tool-proxy': 'lab-web-tool-proxy', 'hermes-agent': 'hermes-agent', 'hermes-dashboard': 'hermes-agent',
	};
	parsed.name = 'treeseed-ai-lab';
	delete parsed.services.gateway;
	for (const [service, role] of Object.entries(roleByService)) parsed.services[service].image = exactImage(role);
	const dataRoot = '${TREESEED_COMPONENT_DATA_ROOT:-/var/lib/treeseed/components}/ai-lab/data';
	const replaceVolume = (service: string, target: string, source: string, suffix = '') => {
		parsed.services[service].volumes = (parsed.services[service].volumes ?? []).map((volume: string) =>
			volume.split(':')[1] === target ? `${dataRoot}/${source}:${target}${suffix}` : volume);
	};
	for (const service of ['experience-proxy', 'controller']) replaceVolume(service, '/state', 'state');
	replaceVolume('controller', '/workspace', 'workspace', ':ro');
	replaceVolume('open-webui', '/app/backend/data', 'open-webui');
	for (const service of ['hermes-agent', 'hermes-dashboard']) {
		replaceVolume(service, '/home/hermes/.hermes', 'hermes');
		replaceVolume(service, '/workspace', 'workspace');
	}
	for (const service of ['experience-proxy', 'controller', 'library-bridge']) parsed.services[service].networks = ['lab-private', 'platform'];
	for (const service of ['open-webui', 'hermes-dashboard', 'controller']) parsed.services[service].networks = [...new Set([...parsed.services[service].networks, 'treeseed-edge'])];
	delete parsed.networks['ai-shared']; delete parsed.networks['lab-edge'];
	parsed.networks.platform = { name: 'treeseed-platform', external: true };
	parsed.networks['treeseed-edge'] = { name: 'treeseed-edge', external: true };
	delete parsed.volumes;
	for (const secret of Object.values(parsed.secrets) as Array<{ file: string }>) secret.file = secret.file.endsWith('/training-source.json')
		? '/etc/treeseed/credentials/ai-lab-training-source'
		: secret.file.replace('/etc/treeseed-ai/lab/secrets/', '/etc/treeseed/credentials/ai-lab-');
	return parsed;
}

function serviceContracts(componentId: keyof typeof definitions) {
	if (componentId === 'ai-inference') return [
		{ id: 'inference-postgres', composeService: 'inference-postgres', endpoints: [] },
		{ id: 'inference-migrations', composeService: 'inference-migrations', endpoints: [] }, { id: 'inference-vllm', composeService: 'inference-vllm', endpoints: [] },
		{ id: 'inference-evaluator', composeService: 'inference-evaluator', endpoints: [] }, { id: 'inference-manager', composeService: 'inference-manager', endpoints: [] },
		{ id: 'inference-api', composeService: 'inference-api', endpoints: [
			{ id: 'control', protocol: 'http', port: 4770, visibility: 'host', defaultAlias: 'inference.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/readyz', timeoutSeconds: 600 } },
			{ id: 'inference', protocol: 'http', port: 4771, visibility: 'private', aliasOverride: false, tls: 'none', authentication: 'application', healthGate: { protocol: 'http', path: '/healthz', timeoutSeconds: 600 } },
		] },
	];
	if (componentId === 'ai-training') return [
		{ id: 'training-postgres', composeService: 'training-postgres', endpoints: [] },
		{ id: 'training-migrations', composeService: 'training-migrations', endpoints: [] }, { id: 'training-marker', composeService: 'training-marker', endpoints: [] },
		{ id: 'training-axolotl', composeService: 'training-axolotl', endpoints: [] }, { id: 'training-artifact', composeService: 'training-artifact', endpoints: [] },
		{ id: 'training-manager', composeService: 'training-manager', endpoints: [] },
		{ id: 'training-api', composeService: 'training-api', endpoints: [{ id: 'control', protocol: 'http', port: 4780, visibility: 'host', defaultAlias: 'training.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/readyz', timeoutSeconds: 600 } }] },
	];
	return [
		{ id: 'experience-proxy', composeService: 'experience-proxy', endpoints: [] },
		{ id: 'controller', composeService: 'controller', endpoints: [{ id: 'control', protocol: 'http', port: 8081, visibility: 'host', defaultAlias: 'lab.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/readyz', timeoutSeconds: 120 } }] },
		{ id: 'library-bridge', composeService: 'library-bridge', endpoints: [] },
		{ id: 'open-webui', composeService: 'open-webui', endpoints: [{ id: 'web', protocol: 'http', port: 8080, visibility: 'host', defaultAlias: 'chat.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'none', healthGate: { protocol: 'http', path: '/health', timeoutSeconds: 120 } }] },
		{ id: 'web-tool-proxy', composeService: 'web-tool-proxy', endpoints: [] }, { id: 'hermes-agent', composeService: 'hermes-agent', endpoints: [] },
		{ id: 'hermes-dashboard', composeService: 'hermes-dashboard', endpoints: [{ id: 'web', protocol: 'http', port: 9119, visibility: 'host', defaultAlias: 'hermes.ai.treeseed.localhost', aliasOverride: true, tls: 'edge', authentication: 'application', healthGate: { protocol: 'http', path: '/', timeoutSeconds: 120 } }] },
	];
}

const results = [];
for (const componentId of Object.keys(definitions) as Array<keyof typeof definitions>) {
	const definition = definitions[componentId];
	const composeName = `${componentId}-compose.yml`, manifestName = `${componentId}-component-release.json`;
	const compose = YAML.stringify(componentId === 'ai-lab' ? labCompose() : baseCompose(componentId));
	if (/\bbuild\s*:/u.test(compose) || /@[A-Z_]+_IMAGE@/u.test(compose) || /^\s*ports\s*:/mu.test(compose)) throw new Error(`${componentId} Compose is not immutable and manager-owned.`);
	const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
	const runtime = {
		schemaVersion: 'treeseed.package-runtime/v1' as const, componentId, version: debianRelease,
		compose: { projectName: `treeseed-${componentId}`, files: [{ path: composeName, digest: composeDigest }] },
		configuration: definition.configuration,
		services: serviceContracts(componentId), stateVolumes: definition.states, migrations: definition.migrations,
		requiredCapabilities: componentId === 'ai-lab' ? ['docker-compose'] : ['docker-compose', 'nvidia-container-runtime'], dependencies: definition.dependencies,
	};
	const localImages = definition.roles.map((role) => {
		const image = manifest.images[role]!;
		return { role, repository: image.repository, digest: image.digest, platforms: ['linux/amd64'], consumers: [componentId] };
	});
	const upstream = componentId === 'ai-lab'
		? []
		: [{ role: 'postgres', ...runtimeImage('postgres'), platforms: ['linux/amd64'], consumers: [componentId] }];
	const componentImages = [...localImages, ...upstream];
	const tagUrl = ({ repository }: { repository: string }) => {
		if (repository.startsWith('treeseed/')) return `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
		if (!repository.includes('/')) return `https://hub.docker.com/_/${repository}/tags`;
		if (repository.startsWith('ghcr.io/')) {
			const path = repository.slice('ghcr.io/'.length), segments = path.split('/');
			return `https://github.com/${segments.slice(0, -1).join('/')}/pkgs/container/${segments.at(-1)}`;
		}
		return `https://${repository}`;
	};
	const bundle = componentReleaseSchema.parse({
		schemaVersion: 'treeseed.component-release/v1', componentId, release: debianRelease, applicationVersion: release, revision, track,
		source: { repository: 'treeseed-ai/ai', commit: sourceCommit },
		stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
		packages: [{ name: `treeseed-component-${componentId}`, version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: definition.order }],
		images: componentImages, runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
		evidence: { provenance: componentImages.map(tagUrl), sboms: componentImages.map(tagUrl), vulnerabilities: [] },
	});
	writeFileSync(resolve(output, composeName), compose);
	writeFileSync(resolve(output, manifestName), `${JSON.stringify(bundle, null, 2)}\n`);
	results.push({ componentId, manifestName, composeName, runtimeDigest: bundle.runtimeDigest, composeDigest });
}
console.log(JSON.stringify({ ok: true, release, debianRelease, components: results }));
