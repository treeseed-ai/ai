import{mkdtempSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{afterEach,expect,it,vi}from'vitest';
import type{ArtifactStore}from'../../packages/common/src/storage.ts';
import{verifyArtifactDestination,verifyArtifactSource}from'../../packages/inference-api/src/artifacts.ts';

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

it('authenticates to the inference destination during readiness',async()=>{
	const prior={bucket:process.env.S3_BUCKET,endpoint:process.env.S3_ENDPOINT,access:process.env.S3_ACCESS_KEY,secret:process.env.S3_SECRET_KEY},send=vi.fn(async()=>({Contents:[]}));
	Object.assign(process.env,{S3_BUCKET:'ai-inference',S3_ENDPOINT:'http://inference-minio:9000',S3_ACCESS_KEY:'inf-test',S3_SECRET_KEY:'not-logged'});
	try{const create=vi.fn(()=>({bucket:'ai-inference',client:{send}}as unknown as ArtifactStore));await verifyArtifactDestination(create);expect(create).toHaveBeenCalledWith('ai-inference','http://inference-minio:9000','inf-test','not-logged');expect(send).toHaveBeenCalledOnce();}
	finally{for(const[key,value]of Object.entries({S3_BUCKET:prior.bucket,S3_ENDPOINT:prior.endpoint,S3_ACCESS_KEY:prior.access,S3_SECRET_KEY:prior.secret}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
