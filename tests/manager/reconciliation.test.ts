import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';
import{objectStoreAccessId}from'../../packages/manager/src/lifecycle/storage/identities.js';

describe('manager-owned platform reconciliation',()=>{
	it('derives stable, separated bundled object-store access IDs',()=>{
		const secret='credential-that-must-not-appear',training=objectStoreAccessId('training',secret);
		expect(training).toBe(objectStoreAccessId('training',secret));expect(training).toMatch(/^trn-[a-f0-9]{12}$/u);expect(training).not.toContain(secret);expect(training.length).toBeLessThanOrEqual(20);
		expect(new Set([objectStoreAccessId('inference',secret),training,objectStoreAccessId('trainingImport',secret)]).size).toBe(3);
		expect(()=>objectStoreAccessId('training','')).toThrow('credential material is missing');
	});
  it('does not start standalone inference and training units',()=>{
    const converge=readFileSync('packages/manager/src/bin/converge.ts','utf8');
    const platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
    expect(converge).not.toContain("`treeseed-ai-${product}.service`");
    expect(platform).toMatch(/compose\(["']training["'],\s*\[["']stop["'],\s*["']marker["'],\s*["']axolotl["']\]\)/u);
    expect(platform).toMatch(/compose\(["']inference["'],\s*\[["']stop["'],\s*["']vllm["']\]\)/u);
    expect(platform).toContain('"transitioning_awake"');
    expect(platform).toContain('"transitioning_sleep"');
  });

  it('keeps raw services private behind the manager gateway',()=>{
    for(const product of['inference','training']){
      const overlay=readFileSync(`deploy/${product}/factory.override.yml`,'utf8');
      expect(overlay).toContain('ports: !reset []');
      expect(overlay).toContain('/var/lib/treeseed-ai/platform:/factory:ro');
    }
    const gateway=readFileSync('deploy/factory/compose.yml','utf8');
    expect(gateway).toContain('/etc/treeseed-ai/manager/tls:/tls:ro');
  });

  it('mounts the signing key only for the artifact worker with the training group',()=>{
    const compose=readFileSync('deploy/training/compose.yml','utf8'),overlay=readFileSync('deploy/training/factory.override.yml','utf8'),platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
    expect(compose).toMatch(/artifact:[\s\S]*secrets: \[artifact-signing-key\]/u);
    expect(overlay).toMatch(/artifact:\n\s+group_add: \["\$\{RUNTIME_GID/u);
    expect(platform).toContain('chown",["root:treeseed-ai-training",privateKey]');
  });

  it('grants only inference services mounted with import secrets the inference group',()=>{
    const overlay=readFileSync('deploy/inference/factory.override.yml','utf8'),platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
    expect(overlay).toMatch(/manager:\n\s+group_add: \["\$\{RUNTIME_GID/u);
    expect(platform).toContain('chown",["root:treeseed-ai-inference",path]');
    expect(platform).toContain('readFileSync(path,"utf8")===value');
    expect(platform).toContain('if(existsSync(path))writeFileSync(path,value,{mode})');
    expect(overlay.match(/TREEAI_SECRET_MOUNT_GENERATION/g)).toHaveLength(2);
    expect(overlay.match(/TREEAI_SECRET_MOUNT_GENERATION: "2"/g)).toHaveLength(2);
  });

  it('provisions a distinct read-only training artifact exchange identity',()=>{
    const compose=readFileSync('deploy/training/compose.yml','utf8'),platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
    expect(compose).toContain('inference-import-policy');expect(compose).toContain('s3:GetObject');expect(compose).not.toMatch(/import-policy\.json[^\n]+s3:\*/u);
    expect(compose).toContain('mc admin user add local $$IMPORT_S3_ACCESS_KEY $$IMPORT_S3_SECRET_KEY');expect(compose).not.toContain('user info local $$IMPORT_S3_ACCESS_KEY');
    expect(compose).toContain('mc ls import-check/$$S3_BUCKET');expect(compose).toContain('$$attempt\\\" -lt 30');
    expect(platform).toContain('accessKeyId: accessIds.trainingImport');expect(platform).toContain('trainingImportS3??=secret()');
		expect(platform).toContain('S3_ACCESS_KEY: accessIds[product]');expect(platform).toContain('IMPORT_S3_ACCESS_KEY:accessIds.trainingImport');
    expect(platform).toContain('["run","--rm","--no-deps","minio-init"]');
    expect(platform).not.toMatch(/inference: \[[^\n]*"minio-init"/u);expect(platform).not.toMatch(/training: \[[^\n]*"minio-init"/u);
    for(const product of['inference','training'])expect(readFileSync(`deploy/${product}/factory.override.yml`,'utf8')).not.toContain('minio-init: { condition:');
    expect(platform.indexOf('reconcileObjectStore(product);',platform.indexOf('export async function transitionMode'))).toBeLessThan(platform.indexOf('writeMode(target);',platform.indexOf('export async function transitionMode')));
  });
	it('gates training API readiness on its effective object-store identity',()=>{
		const compose=readFileSync('deploy/training/compose.yml','utf8'),main=readFileSync('packages/training-api/src/main.ts','utf8');
		expect(main).toContain('HeadBucketCommand');expect(main).toContain('readiness.send');expect(compose).toContain("fetch('http://127.0.0.1:4780/readyz')");
	});
	it('preserves configured images for image-inert package generations',()=>{
		const platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
		const variables=readFileSync('packages/manager/src/core/image-variables.ts','utf8');
		expect(platform).toContain('catalog.imagePolicy.mode === "package-only"');
		expect(platform).toContain('Package-only catalog cannot initialize missing');
		for(const value of['LAB_CONTROLLER_IMAGE','LAB_PROXY_IMAGE','LAB_LIBRARY_BRIDGE_IMAGE','LAB_WEB_TOOL_IMAGE','HERMES_IMAGE'])expect(variables).toContain(value);
	});
	it('keeps the profile verification key readable without exposing the signing key',()=>{
		const source=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
		const postinst=readFileSync('debian/manager/postinst','utf8');
		expect(source).toContain('command("chown", ["root:treeseed-ai-manager", root])');
		expect(source).toContain('command("chown", ["root:treeseed-ai-manager", publicKey])');
		expect(source).toContain('command("chown",["root:treeseed-ai-training",privateKey])');
		expect(source).not.toContain('root:treeseed-ai-manager", privateKey');
		expect(postinst).toContain('chown root:treeseed-ai-manager /etc/treeseed-ai/manager/factory');
		expect(postinst).toContain('chown root:treeseed-ai-manager /etc/treeseed-ai/manager/factory/artifact-signing-public.pem');
		expect(postinst).not.toContain('chown root:treeseed-ai-manager /etc/treeseed-ai/manager/factory/artifact-signing-key.pem');
	});

  it('adds bounded redacted migration diagnostics to failed reconciliation',()=>{
    const platform=readFileSync('packages/manager/src/lifecycle/platform.ts','utf8');
    const diagnostics=readFileSync('packages/manager/src/lifecycle/migrations/diagnostics.ts','utf8');
    expect(diagnostics).toContain('function migrationDiagnostics');
    expect(diagnostics).toContain('redactSensitiveText');
    expect(diagnostics).toContain('"--tail", "80", "migrations"');
    expect(diagnostics).toContain('.slice(-65_536)');
    expect(platform).toContain('reconcileProduct("training"');
    expect(platform).toContain('reconcileProduct("inference"');
  });

  it('backs up and restores the 0.5 coordinator around final handoff',()=>{
    const bootstrap=readFileSync('scripts/bootstrap/bootstrap.sh','utf8');
    expect(bootstrap).toContain('restore_legacy');
    expect(bootstrap).toContain('systemctl stop treeseed-ai-factory.service');
    expect(bootstrap.indexOf('manager-reconcile.service')).toBeLessThan(bootstrap.indexOf('systemctl stop treeseed-ai-factory.service'));
    expect(bootstrap).toContain("trap 'code=$?");
  });

  it('relinquishes the legacy gateway before installing manager-owned packages',()=>{
    const bootstrap=readFileSync('scripts/bootstrap/bootstrap.sh','utf8');
    const gatewayDown=bootstrap.indexOf('treeseed-ai-factory-gateway -f "$legacy/factory-compose/compose.yml" down --remove-orphans');
    const packageInstall=bootstrap.indexOf('apt-get -o DPkg::Lock::Timeout=600 --no-remove');
    expect(gatewayDown).toBeGreaterThan(0);
    expect(gatewayDown).toBeLessThan(packageInstall);
    expect(bootstrap).not.toContain('down --volumes');
    expect(bootstrap).toContain('gateway-was-running');
  });
});
