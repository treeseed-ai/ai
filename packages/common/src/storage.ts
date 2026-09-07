import { GetObjectCommand,HeadObjectCommand,ListObjectsV2Command,PutObjectCommand,S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream,statSync } from 'node:fs';

import type {StorageAction,StorageCustody,StorageLease} from './artifacts/custody.js';

export class ManagedArtifactStore {
	constructor(readonly storeId:string,private readonly custody:StorageCustody){}
	private async operation<T>(action:StorageAction,key:string,run:(client:S3Client,lease:StorageLease)=>Promise<T>):Promise<T>{
		const lease=await this.custody(this.storeId,action,key);
		const client=new S3Client({endpoint:lease.endpoint,credentials:lease.credentials,region:'auto',forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:1});
		try{return await run(client,lease);}catch(error){const status=(error as{$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode;throw Object.assign(new Error('Managed artifact storage operation failed.'),{$metadata:{httpStatusCode:status}});}finally{client.destroy();}
	}
	private async immutablePut(key:string,body:Uint8Array|ReturnType<typeof createReadStream>,size:number,digest:string,contentType:string){
		try{await this.operation('write',key,(client,lease)=>client.send(new PutObjectCommand({Bucket:lease.bucket,Key:lease.objectKey,Body:body,ContentLength:size,ContentType:contentType,Metadata:{sha256:digest},IfNoneMatch:'*'})));}
		catch(error){if((error as{$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode!==412)throw error;const current=await this.head(key);if(current.ContentLength!==size||current.Metadata?.sha256!==digest)throw new Error('Immutable artifact already exists with different content.');}
		finally{if('destroy' in body)body.destroy();}
		return{size,sha256:digest};
	}
	async put(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
		const digest = createHash('sha256').update(body).digest('hex');
		return this.immutablePut(key,body,body.byteLength,digest,contentType);
	}
	async putFile(key:string,path:string,digest:string,contentType='application/octet-stream') {
		const size=statSync(path).size;
		if(size>5_000_000_000)throw new Error('Artifact exceeds the supported single-object upload size.');
		return this.immutablePut(key,createReadStream(path),size,digest,contentType);
	}
	async head(key:string){return this.operation('read',key,(client,lease)=>client.send(new HeadObjectCommand({Bucket:lease.bucket,Key:lease.objectKey})));}
	async bytes(key: string) {
		return this.operation('read',key,async(client,lease)=>{const result=await client.send(new GetObjectCommand({Bucket:lease.bucket,Key:lease.objectKey}));if(!result.Body)throw new Error('Artifact response has no body.');return result.Body.transformToByteArray();});
	}
	async keys(prefix=''){
		const normalized=prefix.replace(/\/$/u,''),keys:string[]=[],seen=new Set<string>();let token:string|undefined;
		do{const page=await this.operation('list',normalized,async(client,lease)=>{
			const result=await client.send(new ListObjectsV2Command({Bucket:lease.bucket,Prefix:lease.objectKey,ContinuationToken:token}));
			for(const item of result.Contents??[]){if(!item.Key?.startsWith(lease.objectKey)||!item.Key.startsWith(lease.prefix))throw new Error('Artifact listing escaped its allocation.');keys.push(item.Key.slice(lease.prefix.length));}return result;});
			if(keys.length>100_000)throw new Error('Artifact listing exceeds its bounded page size.');token=page.IsTruncated?page.NextContinuationToken:undefined;
			if(page.IsTruncated&&(!token||seen.has(token)))throw new Error('Artifact listing returned invalid pagination.');if(token)seen.add(token);
		}while(token);return keys.sort();
	}
}
