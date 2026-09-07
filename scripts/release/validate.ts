import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const read = (path: string) => JSON.parse(readFileSync(resolve(path), 'utf8'));
const manifest = read('release/manifest.json');
assert(manifest.schemaVersion === 'treeai.release/v3', 'Invalid component release manifest.');
assert(/^\d+\.\d+\.\d+$/u.test(manifest.version), 'Release version must be semantic.');
assert(manifest.dockerNamespace === 'treeseed', 'Unexpected image namespace.');
assert(JSON.stringify(manifest.components) === JSON.stringify(['ai-inference', 'ai-training', 'ai-lab']), 'Managed component set differs.');
assert(new Set(manifest.images).size === 17, 'Exactly seventeen unique role images are required.');
for (const field of ['apt', 'products', 'functionalProducts', 'catalog', 'debianVersion'])
	assert(!(field in manifest), 'Host packaging belongs to Deployment, not AI.');
for (const path of ['debian/control', 'systemd/treeseed-ai-manager-api.service', 'packages/manager/package.json', 'packages/cli/package.json', 'packages/host-runtime/package.json', 'deploy/commands/platform.json', 'scripts/package-deb.ts'])
	assert(!existsSync(path), 'Retired standalone implementation remains: ' + path);
const builds = read(manifest.imageBuilds);
assert(builds.schemaVersion === 'treeai.image-builds/v1' && builds.platform === 'linux/amd64', 'Invalid image-build manifest.');
assert(JSON.stringify(Object.keys(builds.images).sort()) === JSON.stringify([...manifest.images].sort()), 'Image-build roles differ.');
for (const [role, value] of Object.entries(builds.images)) {
	const build = value as { dockerfile: string; inputs: string[] };
	assert(build.inputs.includes(build.dockerfile), role + ' omits its Dockerfile.');
	for (const input of build.inputs) assert(existsSync(input), role + ' has a missing input: ' + input);
}
for (const path of ['package.json', ...['common', 'inference-api', 'inference-manager', 'training-api', 'training-manager', 'lab', 'treeai-sdk'].map(name => 'packages/' + name + '/package.json')])
	assert(read(path).version === manifest.version, path + ' version differs.');
for (const image of read(manifest.runtimeImages).runtimeImages)
	assert(/^sha256:[a-f0-9]{64}$/u.test(image.digest) && image.reference.endsWith('@' + image.digest), 'Runtime images must be immutable.');
console.log(JSON.stringify({ status: 'ready', version: manifest.version, components: manifest.components, images: manifest.images.length }));
