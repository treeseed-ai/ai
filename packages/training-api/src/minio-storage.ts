import {createHash,randomUUID}from'node:crypto';
import{Client,type ClientOptions}from'minio';

export interface ObjectWriteResult{uri:string;size:number;sha256:string}
export interface ObjectWriter{put(key:string,body:Uint8Array,contentType?:string):Promise<ObjectWriteResult>}
type PutClient=Pick<Client,'putObject'|'getObject'|'removeObject'>;

export function minioClientOptions(endpoint:string,accessKey:string,secretKey:string,region='us-east-1'):ClientOptions{
	const value=new URL(endpoint);if(!['http:','https:'].includes(value.protocol)||value.username||value.password||value.pathname!=='/'||value.search||value.hash)throw new Error('S3 endpoint must be an HTTP(S) origin');
	return{endPoint:value.hostname,port:value.port?Number(value.port):value.protocol==='https:'?443:80,useSSL:value.protocol==='https:',accessKey,secretKey,region};
}

export class MinioObjectWriter implements ObjectWriter{
	readonly client:PutClient;
	constructor(readonly bucket:string,options:ClientOptions,client?:PutClient){this.client=client??new Client(options);}
	async put(key:string,body:Uint8Array,contentType='application/octet-stream'){
		const bytes=Buffer.from(body),sha256=createHash('sha256').update(bytes).digest('hex');await this.client.putObject(this.bucket,key,bytes,bytes.byteLength,{'Content-Type':contentType,'x-amz-meta-sha256':sha256});return{uri:`s3://${this.bucket}/${key}`,size:bytes.byteLength,sha256};
	}
	async verify(){
		const key=`.treeai-readiness/training-api/${randomUUID()}`,expected=Buffer.from('treeai-object-store-capability-v1');
		try{await this.client.putObject(this.bucket,key,expected,expected.byteLength,{'Content-Type':'application/octet-stream'});const stream=await this.client.getObject(this.bucket,key),chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));if(!Buffer.concat(chunks).equals(expected))throw new Error('Object-store capability probe returned different bytes');}
		finally{await this.client.removeObject(this.bucket,key).catch(()=>undefined);}
	}
}
