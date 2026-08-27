import{chmodSync,mkdtempSync,mkdirSync,readFileSync,symlinkSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{describe,expect,it}from'vitest';
import{computeBuildIdentity,reuseEligible,type ImageBuild}from'../../scripts/release/plan-image-builds.js';

describe('selective image build identities',()=>{
  it('reuses only an exact valid deterministic build identity',()=>{
    expect(reuseEligible({previousValid:true,buildIdentityMatches:true})).toBe(true);
    expect(reuseEligible({previousValid:true,buildIdentityMatches:false})).toBe(false);
    expect(reuseEligible({previousValid:false,buildIdentityMatches:true})).toBe(false);
  });

  it('publishes exact RC images and a manager-owned component bundle',()=>{
    const workflow=readFileSync('.github/workflows/publish-development.yml','utf8');
    expect(workflow).toContain('TREEAI_RC_TAG=${version}-rc${{ inputs.rc }}');
    expect(workflow).not.toContain('tag="dev-');
    expect(workflow).toContain('docker/login-action');
    expect(workflow).toContain('docker buildx build');
    expect(workflow).toContain('cosign sign');
    expect(workflow).toContain('cosign verify');
    expect(workflow).toContain('docker buildx imagetools inspect');
    expect(workflow).not.toContain('docker buildx imagetools create --tag');
    expect(workflow).toContain('.images[$role].disposition="reused"');
    expect(workflow).toContain('recover_run_id');
    expect(workflow).toContain('git diff --quiet "$recovery_sha" HEAD');
    expect(workflow).toContain('.name == "Publish every exact RC image and verify Docker Hub read-back" and .conclusion == "success"');
    expect(workflow).toContain('.name == "Publish immutable prerelease" and .conclusion == "failure"');
    expect(workflow).toContain('checksum=$(mktemp)');
    expect(workflow).toContain('find . -maxdepth 1 -type f ! -name SHA256SUMS');
    expect(workflow).not.toContain('xargs sha256sum > SHA256SUMS');
    expect(workflow).toContain('pnpm build:component-release');
    expect(workflow).toContain('TREEAI_DEVELOPMENT_BASE');
    expect(workflow).not.toContain('dpkg-buildpackage');
    expect(workflow).not.toContain('mirror-apt-suite.sh');
  });

	it('promotes verified candidate digests without rebuilding them',()=>{
		const workflow=readFileSync('.github/workflows/release.yml','utf8');
		expect(workflow).toContain('candidate: { description: Exact verified release candidate to promote');
		expect(workflow).toContain('TREEAI_PROMOTE_REUSED=1');
		expect(workflow).toContain('candidate-download/image-manifest.json');
		expect(workflow).toContain('git rev-parse "$candidate_commit^{tree}"');
		expect(workflow).toContain('test ! -f "previous-assets/vulnerabilities/$role.json"');
		expect(workflow).toContain('docker buildx imagetools create -t "treeseed/$role:${{ inputs.version }}"');
	});

  it('covers every coordinated role with explicit inputs',()=>{
    const release=JSON.parse(readFileSync('release/manifest.json','utf8'))as{images:string[]};
    const builds=JSON.parse(readFileSync('release/image-builds.json','utf8'))as{platform:string;images:Record<string,ImageBuild>};
    expect(Object.keys(builds.images).sort()).toEqual([...release.images].sort());
    expect(builds.platform).toBe('linux/amd64');
    for(const [role,build]of Object.entries(builds.images)){expect(build.inputs.length,role).toBeGreaterThan(0);expect(build.inputs).toContain(build.dockerfile);}
		for(const role of['inference-api','inference-manager','training-api','training-manager','lab-controller','lab-experience-proxy'])expect(builds.images[role]?.inputs).not.toContain('packages');
		for(const role of['inference-migrations','training-migrations'])expect(builds.images[role]?.inputs).toContain('containers/migrations/run.sh');
		for(const role of['lab-controller','lab-experience-proxy','lab-library-bridge']){expect(builds.images[role]?.inputs).not.toContain('packages/lab');expect(builds.images[role]?.inputs).not.toContain('packages/lab/src/cli.ts');expect(builds.images[role]?.inputs).not.toContain('packages/lab/src/corpus.ts');}
		expect(builds.images['lab-controller']?.inputs).toContain('packages/lab/src/controller.ts');expect(builds.images['lab-experience-proxy']?.inputs).toContain('packages/lab/src/proxy.ts');expect(builds.images['lab-library-bridge']?.inputs).toContain('packages/lab/src/library-bridge.ts');
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
