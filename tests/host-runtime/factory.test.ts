import { scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'ai-factory-test-'));
process.env.AI_FACTORY_STATE = join(root, 'mode.json');
process.env.AI_FACTORY_RECEIPT_ROOT = join(root, 'transitions');
const secret = 'factory-test-secret';
const salt = '00112233445566778899aabbccddeeff';
process.env.AI_FACTORY_API_KEYS = JSON.stringify([{
  id: 'test', hash: `scrypt:${salt}:${scryptSync(secret, salt, 32).toString('hex')}`,
  scopes: ['factory:*'], revoked: false,
}]);
writeFileSync(process.env.AI_FACTORY_STATE, JSON.stringify({ schemaVersion: 'ai.factory-state/v1', mode: 'awake', updatedAt: new Date(0).toISOString() }));
const { createFactoryApp } = await import('../../packages/host-runtime/src/factory/api.js');
const { run } = await import('../../packages/host-runtime/src/factory/shared.js');

describe('local factory contracts', () => {
  it('handles successful commands whose output is inherited', () => {
    expect(run('true', [])).toBe('');
  });
  it('publishes OpenAPI 3.1.1 and protects factory state', async () => {
    const app = createFactoryApp();
    expect((await (await app.request('/openapi.json')).json()).openapi).toBe('3.1.1');
    expect((await app.request('/v1/mode')).status).toBe(401);
    const response = await app.request('/v1/mode', { headers: { authorization: `Bearer ak_test_${secret}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).mode).toBe('awake');
  });
  it('keeps raw state services private and uses a named artifact-source secret', () => {
    const inference = readFileSync('deploy/inference/factory.override.yml', 'utf8');
    const training = readFileSync('deploy/training/factory.override.yml', 'utf8');
    const gateway = readFileSync('deploy/factory/compose.yml', 'utf8');
    expect(inference).toContain('training-local-source');
    expect(inference).toContain('ports: !reset []');
    expect(inference).toMatch(/vllm:[\s\S]*?restart: "no"/u);
    expect(training).toContain('ports: !reset []');
    expect(training).toMatch(/marker:[\s\S]*?restart: "no"[\s\S]*?axolotl:[\s\S]*?restart: "no"/u);
    expect(gateway).toContain('0.0.0.0:4771:4771');
    expect(gateway).not.toMatch(/9000:9000|5432:5432|8000:8000/u);
    expect(inference).toContain('group_add: ["${RUNTIME_GID:?RUNTIME_GID is required}"]');
    expect(training).toContain('group_add: ["${RUNTIME_GID:?RUNTIME_GID is required}"]');
  });
  it('declares the descending two-request context qualification profile', () => {
    const activation = readFileSync('packages/host-runtime/src/factory/activation.ts', 'utf8');
    const configure = readFileSync('packages/host-runtime/src/factory/configure.ts', 'utf8');
    expect(activation).toContain('65_536');
    expect(activation).toContain('tokens-=4_096');
    expect(activation).toContain('ThreadPoolExecutor(max_workers=2)');
    expect(activation).toContain("throw new Error('No context profile of at least 16384");
    expect(activation).toContain('AutoTokenizer');
    expect(configure).toContain("'genpkey','-algorithm','Ed25519'");
  });
  it('treats migrations and MinIO setup as successful completion jobs', () => {
    const activation = readFileSync('packages/host-runtime/src/factory/activation.ts', 'utf8');
    expect(activation).toContain("completionGate('inference',['minio-init','migrations'])");
    expect(activation).toContain("completionGate('training',['minio-init','migrations'])");
    expect(activation).toContain("state.Status==='exited'&&state.ExitCode===0");
    expect(activation).toContain("['ps','-a','-q',service],'pipe'");
    expect(activation).not.toContain("gate('inference',['minio-init','migrations'])");
    expect(activation).toContain("'https://localhost:4790/readyz'");
    expect(activation).toContain("coordinatorGate();");
  });
  it('provides planning, transactional receipts, pinned builds, and a public client CA', () => {
    const cli = readFileSync('packages/host-runtime/src/factory/dev-cli.ts', 'utf8');
    const configure = readFileSync('packages/host-runtime/src/factory/configure.ts', 'utf8');
    const planning = readFileSync('packages/host-runtime/src/factory/planning.ts', 'utf8');
    const build = readFileSync('packages/host-runtime/src/factory/build.ts', 'utf8');
    const shared = readFileSync('packages/host-runtime/src/factory/shared.ts', 'utf8');
    const bake = readFileSync('deploy/factory/docker-bake.hcl', 'utf8');
    expect(cli).toContain("command==='plan'");
    expect(cli).toContain('--rotate-client-keys');
    expect(configure).toContain('configuration-receipt.json');
    expect(planning).toContain("RUNTIME_GID:'0'");
    expect(build).toContain("Factory plan is blocked:\\n${blocked}");
    expect(shared).toContain('/etc/ssl/certs/treeseed-ai-factory-development-ca.pem');
    expect(bake.match(/target "/gu)).toHaveLength(12);
    for (const file of ['containers/inference/api.Dockerfile', 'containers/inference/vllm.Dockerfile', 'containers/training/axolotl.Dockerfile']) {
      expect(readFileSync(file, 'utf8')).toMatch(/(?:FROM|ARG .*IMAGE=).*@sha256:[a-f0-9]{64}/u);
    }
    expect(readFileSync('containers/inference/api.Dockerfile', 'utf8')).toContain('npm@12.0.2');
    expect(readFileSync('containers/inference/migrations.Dockerfile', 'utf8')).toContain('postgresql17-client=17.11-r0');
    expect(readFileSync('containers/inference/vllm.Dockerfile', 'utf8')).toContain('apt-get upgrade -y');
    expect(readFileSync('containers/training/axolotl.Dockerfile', 'utf8')).toContain('/opt/nvidia/nsight-compute');
    for (const worker of ['evaluator','artifact','marker','axolotl']) {
      expect(readFileSync(`workers/${worker}/requirements.lock`, 'utf8')).toContain('--hash=sha256:');
    }
    const markerInput = readFileSync('workers/marker/requirements.in', 'utf8');
    const markerLock = readFileSync('workers/marker/requirements.lock', 'utf8');
    expect(markerInput).toContain('torch==2.7.1');
    expect(markerLock).toContain('torch==2.7.1');
    expect(markerLock).not.toContain('cuda-toolkit==13.0.4.0');
    expect(readFileSync('workers/axolotl/requirements.lock', 'utf8')).toContain('accelerate==1.10.0');
  });
  it('uses read-only worker syntax probes and retains smoke-test diagnostics', () => {
    const build = readFileSync('packages/host-runtime/src/factory/build.ts', 'utf8');
    expect(build).not.toContain("'-m','py_compile'");
    expect(build).toContain('ast.parse');
    expect(build).toContain("'logs','--tail','100'");
    expect(build).toContain("GIT_OPTIONAL_LOCKS:'0'");
  });
  it('keeps factory status concise and prepares writable product status directories', () => {
    const coordinator = readFileSync('packages/host-runtime/src/factory/coordinator.ts', 'utf8');
    const shared = readFileSync('packages/host-runtime/src/factory/shared.ts', 'utf8');
    expect(coordinator).not.toContain('Labels:');
    expect(coordinator).toContain('service:value.Service');
    expect(shared).toContain('prepareRuntimeDirectory');
    expect(shared).toContain("setProductEnvironment(product,'RUNTIME_GID',gid)");
  });
});
