import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Target = 'ai-inference' | 'ai-training' | 'ai-lab';
const targets: Record<Target, string[]> = {
	'ai-inference': ['inference-api', 'inference-manager', 'inference-vllm', 'inference-evaluator', 'inference-migrations'],
	'ai-training': ['training-api', 'training-manager', 'axolotl-worker', 'marker-worker', 'artifact-worker', 'training-migrations'],
	'ai-lab': ['lab-controller', 'lab-experience-proxy', 'lab-library-bridge', 'lab-open-webui', 'hermes-agent', 'lab-web-tool-proxy'],
};
const [targetValue, operation = 'plan'] = process.argv.slice(2);
if (!(targetValue in targets)) throw new Error('Target must be ai-inference, ai-training, or ai-lab.');
const target = targetValue as Target, roles = targets[target];
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const suffix = sourceCommit.slice(0, 12), receiptPath = resolve(`.treeseed/development/${target}.json`);
const builds = JSON.parse(readFileSync('release/image-builds.json', 'utf8')) as { images: Record<string, { dockerfile: string; buildArgs?: Record<string, string> }> };
const entries = roles.map((role) => ({ role, tag: `local/${role}:treeai-${suffix}`, ...builds.images[role] }));
if (entries.some(({ dockerfile }) => !dockerfile)) throw new Error(`The ${target} image build inventory is incomplete.`);

function inspect() {
	return entries.map(({ role, tag }) => ({ role, tag, imageId: execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { encoding: 'utf8' }).trim() }));
}

if (operation === 'plan') process.stdout.write(`${JSON.stringify({ status: 'ready', target, sourceCommit, images: entries.map(({ role, tag, dockerfile }) => ({ role, tag, dockerfile })) }, null, 2)}\n`);
else if (operation === 'build') {
	for (const { tag, dockerfile, buildArgs = {} } of entries) {
		const args = ['buildx', 'build', '.', '--file', dockerfile, '--platform', 'linux/amd64', '--load', '--tag', tag];
		for (const [name, value] of Object.entries(buildArgs)) args.push('--build-arg', `${name}=${value}`);
		execFileSync('docker', args, { stdio: 'inherit' });
	}
	mkdirSync(resolve(receiptPath, '..'), { recursive: true });
	const receipt = { schemaVersion: 'treeai.development-build/v1', target, sourceCommit, images: inspect(), builtAt: new Date().toISOString() };
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ status: 'ready', receipt: receiptPath, ...receipt })}\n`);
} else if (operation === 'verify') {
	const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { sourceCommit: string; images: Array<{ role: string; tag: string; imageId: string }> };
	const observed = inspect();
	if (receipt.sourceCommit !== sourceCommit || JSON.stringify(receipt.images) !== JSON.stringify(observed)) throw new Error(`The ${target} development receipt does not match the worktree or local images.`);
	process.stdout.write(`${JSON.stringify({ status: 'ready', target, sourceCommit, images: observed })}\n`);
} else if (operation === 'cleanup') {
	for (const { tag } of entries) execFileSync('docker', ['image', 'rm', tag], { stdio: 'inherit' });
	rmSync(receiptPath, { force: true });
} else throw new Error('Operation must be plan, build, verify, or cleanup.');
