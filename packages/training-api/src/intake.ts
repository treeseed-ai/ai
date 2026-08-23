import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

const maximum=100*1024*1024;
export interface UploadMetadata {externalId:string;filename:string;relativePath:string;directoryExternalId?:string;declaredMimeType?:string;provenance?:Record<string,unknown>}
export function metadata(value:string|undefined){
	if(!value)throw new Error('X-TreeAI-Document metadata is required');
	let parsed:unknown;try{parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new Error('X-TreeAI-Document metadata is invalid');}
	if(!parsed||typeof parsed!=='object')throw new Error('Document metadata must be an object');const input=parsed as Partial<UploadMetadata>;
	if(!input.externalId||!input.filename||!input.relativePath)throw new Error('externalId, filename, and relativePath are required');
	if([input.externalId,input.filename,input.relativePath,input.directoryExternalId??''].some((item)=>item.length>500||item.includes('\0')))throw new Error('Document metadata is invalid');
	const parts=input.relativePath.replaceAll('\\','/').split('/');if(input.relativePath.startsWith('/')||parts.includes('..'))throw new Error('Document paths must be relative');
	return input as UploadMetadata;
}
export async function spool(body:ReadableStream<Uint8Array>|null,expected:string|undefined){
	if(!body)throw new Error('Document body is required');const directory=await mkdtemp(join(tmpdir(),'treeai-library-')),path=join(directory,'upload'),output=createWriteStream(path,{flags:'wx',mode:0o600}),hash=createHash('sha256');let size=0;
	try{const reader=body.getReader();while(true){const{done,value}=await reader.read();if(done)break;const bytes=Buffer.from(value);size+=bytes.length;if(size>maximum)throw new Error('Document exceeds the 100 MiB limit');hash.update(bytes);if(!output.write(bytes))await new Promise<void>((resolve)=>output.once('drain',resolve));}output.end();await finished(output);const sha256=hash.digest('hex');if(expected&&expected!==sha256)throw new Error('Document SHA-256 does not match');return{directory,path,size,sha256};}
	catch(error){output.destroy();await rm(directory,{recursive:true,force:true});throw error;}
}
