import { ArtifactStore,sha256,verifyManifest,type ArtifactManifest,type Job } from '@ai-platform/common';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';

interface SourceRegistry {sourceId:string;endpoint:string;bucket:string;accessKeyId:string;secretAccessKey:string;trustedPublicKey:string}
function objectKey(uri:string,bucket:string){const match=uri.match(/^s3:\/\/([^/]+)\/(.+)$/u);if(!match||match[1]!==bucket)throw new Error(`Object URI is outside the registered ${bucket} bucket.`);return match[2]!;}
function store(bucket:string,endpoint:string,accessKeyId:string,secretAccessKey:string){return new ArtifactStore(bucket,{endpoint,region:process.env.S3_REGION??'us-east-1',forcePathStyle:true,credentials:{accessKeyId,secretAccessKey}});}
async function putOnce(store:ArtifactStore,key:string,bytes:Uint8Array,contentType?:string){const digest=sha256(bytes);try{const existing=await store.head(key);if(existing.ContentLength===bytes.byteLength&&existing.Metadata?.sha256===digest)return{uri:`s3://${store.bucket}/${key}`,size:bytes.byteLength,sha256:digest};}catch{/* missing or incomplete objects are copied */}return store.put(key,bytes,contentType);}

export function createArtifactImporter(pool:Pool){
  return async(job:Job)=>{
    const request=job.request as{sourceId?:string;manifestUri?:string};
    const source=JSON.parse(readFileSync(process.env.ARTIFACT_SOURCE_REGISTRY!,'utf8'))as SourceRegistry;
    if(request.sourceId!==source.sourceId||!request.manifestUri)throw new Error('Unknown artifact source or missing manifest URI.');
    const input=store(source.bucket,source.endpoint,source.accessKeyId,source.secretAccessKey);
    const manifestBytes=await input.bytes(objectKey(request.manifestUri,source.bucket));
    const manifest=JSON.parse(Buffer.from(manifestBytes).toString('utf8'))as ArtifactManifest;
    if(!verifyManifest(manifest,createPublicKey(source.trustedPublicKey)))throw new Error('Artifact manifest signature is invalid.');
    if(manifest.artifactType!=='lora-adapter'||manifest.adapter?.format!=='peft')throw new Error('Manifest is not a compatible PEFT LoRA adapter.');
    if(manifest.baseModel?.id!==(process.env.SOURCE_MODEL??'Qwen/Qwen3.5-4B')||manifest.baseModel?.revision!==(process.env.SOURCE_MODEL_REVISION??'851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a'))throw new Error('Adapter base model revision is incompatible with this inference deployment.');
    const output=store(process.env.S3_BUCKET??'ai-inference',process.env.S3_ENDPOINT!,process.env.S3_ACCESS_KEY!,process.env.S3_SECRET_KEY!);
    const copied=[];
    for(const object of manifest.objects){const bytes=await input.bytes(objectKey(object.uri,source.bucket));if(bytes.byteLength!==object.size||sha256(bytes)!==object.sha256)throw new Error(`Checksum verification failed for ${object.uri}.`);copied.push(await putOnce(output,`objects/${object.sha256}`,bytes));}
    const manifestDigest=sha256(manifestBytes);const stored=await putOnce(output,`manifests/${manifest.artifactId}/${manifestDigest}.json`,manifestBytes,'application/json');
    const candidate=await pool.query(`INSERT INTO candidates(manifest_uri,manifest,status) VALUES($1,$2,'inactive') ON CONFLICT(manifest_uri) DO UPDATE SET manifest=excluded.manifest RETURNING id`,[stored.uri,{sourceManifest:manifest,copiedObjects:copied,sourceId:source.sourceId}]);
    return `candidate://${candidate.rows[0].id}`;
  };
}
