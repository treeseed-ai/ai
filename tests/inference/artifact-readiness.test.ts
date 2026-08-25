import{mkdtempSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{afterEach,expect,it,vi}from'vitest';
import type{ArtifactStore}from'../../packages/common/src/storage.ts';
import{verifyArtifactSource}from'../../packages/inference-api/src/artifacts.ts';

const prior=process.env.ARTIFACT_SOURCE_REGISTRY;
afterEach(()=>{if(prior)process.env.ARTIFACT_SOURCE_REGISTRY=prior;else delete process.env.ARTIFACT_SOURCE_REGISTRY;});

it('authenticates to the named training source during readiness',async()=>{
	const root=mkdtempSync(join(tmpdir(),'treeai-artifact-source-')),path=join(root,'source.json'),send=vi.fn(async()=>({Contents:[]}));
	writeFileSync(path,JSON.stringify({sourceId:'training-local',endpoint:'http://training-minio:9000',bucket:'ai-training',accessKeyId:'xfer-test',secretAccessKey:'not-logged',trustedPublicKey:'unused'}));
	process.env.ARTIFACT_SOURCE_REGISTRY=path;
	const create=vi.fn(()=>({client:{send}}as unknown as ArtifactStore));
	await verifyArtifactSource(create);
	expect(create).toHaveBeenCalledWith('ai-training','http://training-minio:9000','xfer-test','not-logged');
	expect(send).toHaveBeenCalledOnce();
});

it('fails readiness when the training source rejects its credential',async()=>{
	const root=mkdtempSync(join(tmpdir(),'treeai-artifact-source-')),path=join(root,'source.json');
	writeFileSync(path,JSON.stringify({sourceId:'training-local',endpoint:'http://training-minio:9000',bucket:'ai-training',accessKeyId:'missing',secretAccessKey:'not-logged',trustedPublicKey:'unused'}));
	process.env.ARTIFACT_SOURCE_REGISTRY=path;
	await expect(verifyArtifactSource(()=>({client:{send:async()=>{throw new Error('source credential rejected');}}}as unknown as ArtifactStore))).rejects.toThrow('source credential rejected');
});
