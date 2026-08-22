import{chmodSync,mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{describe,expect,it}from'vitest';
import{computeBuildIdentity,type ImageBuild}from'../../scripts/release/plan-image-builds.js';

describe('selective image build identities',()=>{
  it('covers every coordinated role with explicit inputs',()=>{
    const release=JSON.parse(readFileSync('release/manifest.json','utf8'))as{images:string[]};
    const builds=JSON.parse(readFileSync('release/image-builds.json','utf8'))as{platform:string;images:Record<string,ImageBuild>};
    expect(Object.keys(builds.images).sort()).toEqual([...release.images].sort());
    expect(builds.platform).toBe('linux/amd64');
    for(const [role,build]of Object.entries(builds.images)){expect(build.inputs.length,role).toBeGreaterThan(0);expect(build.inputs).toContain(build.dockerfile);}
  });

  it('changes for Dockerfiles, context, arguments, and platforms',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-identity-')),build:ImageBuild={dockerfile:'Containerfile',inputs:['Containerfile','context'],buildArgs:{ROLE:'api'}};
    mkdirSync(join(root,'context'));
    writeFileSync(join(root,'Containerfile'),'FROM scratch\nCOPY context /app\n');
    writeFileSync(join(root,'context','entry'),'one');
    const initial=computeBuildIdentity('role',build,'linux/amd64',root);
    writeFileSync(join(root,'Containerfile'),'FROM scratch\nCOPY context /service\n');
    expect(computeBuildIdentity('role',build,'linux/amd64',root)).not.toBe(initial);
    writeFileSync(join(root,'Containerfile'),'FROM scratch\nCOPY context /app\n');
    writeFileSync(join(root,'context','entry'),'two');
    expect(computeBuildIdentity('role',build,'linux/amd64',root)).not.toBe(initial);
    writeFileSync(join(root,'context','entry'),'one');
    expect(computeBuildIdentity('role',{...build,buildArgs:{ROLE:'worker'}},'linux/amd64',root)).not.toBe(initial);
    expect(computeBuildIdentity('role',build,'linux/arm64',root)).not.toBe(initial);
    chmodSync(join(root,'context','entry'),0o755);
    expect(computeBuildIdentity('role',build,'linux/amd64',root)).not.toBe(initial);
  });

  it('keeps ignored generated files out of identities',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-identity-')),build:ImageBuild={dockerfile:'Containerfile',inputs:['Containerfile','context']};
    mkdirSync(join(root,'context','dist'),{recursive:true});
    writeFileSync(join(root,'.dockerignore'),'**/dist\n');
    writeFileSync(join(root,'Containerfile'),'FROM scratch\nCOPY context /app\n');
    writeFileSync(join(root,'context','source'),'source');
    writeFileSync(join(root,'context','dist','generated'),'one');
    const initial=computeBuildIdentity('role',build,'linux/amd64',root);
    writeFileSync(join(root,'context','dist','generated'),'two');
    expect(computeBuildIdentity('role',build,'linux/amd64',root)).toBe(initial);
  });

  it('rejects symlinks inside build contexts',()=>{
    const root=mkdtempSync(join(tmpdir(),'treeai-identity-')),build:ImageBuild={dockerfile:'Containerfile',inputs:['Containerfile','context']};
    mkdirSync(join(root,'context'));
    writeFileSync(join(root,'Containerfile'),'FROM scratch\nCOPY context /app\n');
    writeFileSync(join(root,'outside'),'outside');
    symlinkSync(join(root,'outside'),join(root,'context','linked'));
    expect(()=>computeBuildIdentity('role',build,'linux/amd64',root)).toThrow('Build identity input cannot be a symlink');
  });
});
