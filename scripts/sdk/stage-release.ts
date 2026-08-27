import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const release = process.env.TREEAI_CONTRACT_RELEASE;
const sourceCommit = process.env.TREEAI_SOURCE_COMMIT;
if (!release || !sourceCommit || !/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Exact contract release and source commit are required.');
const output = resolve(process.env.TREEAI_CONTRACT_OUTPUT ?? 'release-assets/component');
mkdirSync(output, { recursive: true });

const staged: Record<string, { file: string; sha256: string }> = {};
function stage(id: string, source: string, destination: string) {
	cpSync(resolve(source), resolve(output, destination));
	staged[id] = { file: destination, sha256: createHash('sha256').update(readFileSync(resolve(output, destination))).digest('hex') };
}

for (const service of ['inference', 'training', 'lab', 'qualification']) stage(`openapi.${service}`, `packages/treeai-sdk/openapi/${service}.json`, `treeai-${service}-openapi.json`);
stage('operationInventory', 'packages/treeai-sdk/operation-inventory.json', 'treeai-operation-inventory.json');
stage('sdkManifest', 'packages/treeai-sdk/sdk-manifest.yaml', 'treeai-sdk-manifest.yaml');

execFileSync('pnpm', ['--filter', '@treeseed/treeai', 'pack', '--pack-destination', output], { stdio: 'inherit' });
const archive = readdirSync(output).find((file) => /^treeseed-treeai-.*\.tgz$/u.test(file));
if (!archive) throw new Error('The TreeAI SDK archive was not produced.');
const archiveName = `treeseed-treeai-${release}.tgz`;
if (archive !== archiveName) renameSync(resolve(output, archive), resolve(output, archiveName));
staged.sdk = { file: archiveName, sha256: createHash('sha256').update(readFileSync(resolve(output, archiveName))).digest('hex') };

const inventory = JSON.parse(readFileSync(resolve('packages/treeai-sdk/operation-inventory.json'), 'utf8')) as { operations: unknown[] };
writeFileSync(resolve(output, 'treeai-contract-release.json'), `${JSON.stringify({
	schemaVersion: 'treeai.contract-release/v1', release, source: { repository: 'treeseed-ai/ai', commit: sourceCommit },
	openapiVersion: '3.1.1', operationCount: inventory.operations.length, artifacts: staged,
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'ready', release, sourceCommit, operationCount: inventory.operations.length, artifacts: Object.keys(staged) })}\n`);
