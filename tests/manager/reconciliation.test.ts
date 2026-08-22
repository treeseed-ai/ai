import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';

describe('manager-owned platform reconciliation',()=>{
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

  it('backs up and restores the 0.5 coordinator around final handoff',()=>{
    const bootstrap=readFileSync('scripts/bootstrap/bootstrap.sh','utf8');
    expect(bootstrap).toContain('restore_legacy');
    expect(bootstrap).toContain('systemctl stop treeseed-ai-factory.service');
    expect(bootstrap.indexOf('manager-reconcile.service')).toBeLessThan(bootstrap.indexOf('systemctl stop treeseed-ai-factory.service'));
    expect(bootstrap).toContain("trap 'code=$?");
  });
});
