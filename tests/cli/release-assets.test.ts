import{mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{spawnSync}from'node:child_process';
import{describe,expect,it}from'vitest';

function run(source:string,destination:string){return spawnSync(process.execPath,['--import','tsx','scripts/release/stage-release-assets.ts',source,destination],{encoding:'utf8'})}

describe('release asset staging',()=>{
	it('keeps the newest Debian changelog entry chronologically newest',()=>{
		const dates=[...readFileSync('debian/changelog','utf8').matchAll(/^ -- .+?  (.+)$/gmu)].map(match=>Date.parse(match[1]!));
		expect(dates.length).toBeGreaterThan(1);
		expect(dates.every(Number.isFinite)).toBe(true);
		expect(dates[0]).toBeGreaterThan(dates[1]!);
	});

  it('matches GitHub Release basename publication',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-assets-')),source=join(root,'source'),destination=join(root,'published');
    mkdirSync(join(source,'sboms'),{recursive:true});
    mkdirSync(join(source,'vulnerabilities'));
    writeFileSync(join(source,'image-manifest.json'),'manifest');
    writeFileSync(join(source,'sboms','role.spdx.json'),'sbom');
    writeFileSync(join(source,'vulnerabilities','role.json'),'report');
    writeFileSync(join(source,'SHA256SUMS'),'obsolete');
    const result=run(source,destination);
    expect(result.status,result.stderr).toBe(0);
    expect(readFileSync(join(destination,'role.spdx.json'),'utf8')).toBe('sbom');
    expect(readFileSync(join(destination,'role.json'),'utf8')).toBe('report');
    expect(()=>readFileSync(join(destination,'SHA256SUMS'))).toThrow();
  });

  it('rejects duplicate published basenames',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-assets-')),source=join(root,'source');
    mkdirSync(join(source,'one'),{recursive:true});
    mkdirSync(join(source,'two'));
    writeFileSync(join(source,'one','report.json'),'one');
    writeFileSync(join(source,'two','report.json'),'two');
    const result=run(source,join(root,'published'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Duplicate published release asset name report.json');
  });

  it('rejects symlinked release assets',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-assets-')),source=join(root,'source');
    mkdirSync(source);
    writeFileSync(join(root,'payload'),'payload');
    symlinkSync(join(root,'payload'),join(source,'payload'));
    const result=run(source,join(root,'published'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release asset cannot be a symlink');
  });
});
