import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,createReadStream,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,relative,resolve,sep} from 'node:path';
import {ArtifactStore} from '../storage.js';
import {ListObjectsV2Command,type S3ClientConfig} from '@aws-sdk/client-s3';

export interface RepositoryObject{uri:string;key:string;size:number;sha256:string}
export interface ArtifactRepository{
	readonly storeId:string;
	uri(key:string):string;
	key(uri:string):string;
	put(key:string,body:Uint8Array,contentType?:string):Promise<RepositoryObject>;
	putFile(key:string,path:string,contentType?:string):Promise<RepositoryObject>;
	bytes(uriOrKey:string):Promise<Uint8Array>;
	head(uriOrKey:string):Promise<RepositoryObject>;
	list(prefix?:string):Promise<RepositoryObject[]>;
}

function digest(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
async function fileDigest(path:string){return new Promise<string>((resolveDigest,reject)=>{const hash=createHash('sha256'),stream=createReadStream(path);stream.on('data',(chunk)=>hash.update(chunk));stream.on('end',()=>resolveDigest(hash.digest('hex')));stream.on('error',reject);});}
function isNotFound(error:unknown){const value=error as {name?:string;$metadata?:{httpStatusCode?:number}};return value?.$metadata?.httpStatusCode===404||value?.name==='NotFound'||value?.name==='NoSuchKey';}
export function artifactKey(value:string){const segments=value.split('/');if(!value||value.startsWith('/')||segments.some((item)=>!item||item==='.'||item==='..'))throw new Error('Artifact key is invalid.');return segments.join('/');}
export function artifactUri(storeId:string,key:string){if(!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(storeId))throw new Error('Artifact store ID is invalid.');return`artifact://${storeId}/${artifactKey(key)}`;}
export function resolveArtifactKey(value:string,storeId:string,legacyBuckets:string[]=[]){if(!value.includes('://'))return artifactKey(value);const parsed=value.match(/^artifact:\/\/([^/]+)\/(.+)$/u);if(parsed){if(parsed[1]!==storeId)throw new Error('Artifact belongs to a different store.');return artifactKey(parsed[2]!);}const legacy=value.match(/^s3:\/\/([^/]+)\/(.+)$/u);if(legacy&&legacyBuckets.includes(legacy[1]!))return artifactKey(legacy[2]!);throw new Error('Artifact URI is not accepted by this store.');}

export class FilesystemArtifactRepository implements ArtifactRepository{
	readonly root:string;
	constructor(readonly storeId:string,root:string,readonly legacyBuckets:string[]=[]){this.root=resolve(root);mkdirSync(this.root,{recursive:true,mode:0o750});if(lstatSync(this.root).isSymbolicLink())throw new Error('Artifact root cannot be a symlink.');}
	uri(key:string){return artifactUri(this.storeId,key);}
	key(uri:string){return resolveArtifactKey(uri,this.storeId,this.legacyBuckets);}
	private path(key:string){const target=resolve(this.root,artifactKey(key));if(target!==this.root&&!target.startsWith(`${this.root}${sep}`))throw new Error('Artifact path escapes its store.');return target;}
	private directories(target:string){const parent=dirname(target),parts=relative(this.root,parent).split(sep).filter(Boolean);let current=this.root;for(const part of parts){current=resolve(current,part);if(existsSync(current)){if(lstatSync(current).isSymbolicLink()||!lstatSync(current).isDirectory())throw new Error('Artifact path contains an unsafe component.');}else mkdirSync(current,{mode:0o750});}}
	private inspect(key:string){const path=this.path(key),info=lstatSync(path);if(info.isSymbolicLink()||!info.isFile())throw new Error('Artifact is not a regular file.');const bytes=readFileSync(path);return{uri:this.uri(key),key,size:info.size,sha256:digest(bytes)};}
	async put(key:string,body:Uint8Array){key=artifactKey(key);const target=this.path(key),sha256=digest(body);this.directories(target);if(existsSync(target)){const current=this.inspect(key);if(current.sha256!==sha256||current.size!==body.byteLength)throw new Error('Immutable artifact already exists with different content.');return current;}const temporary=`${target}.treeai-${randomUUID()}`;try{writeFileSync(temporary,body,{flag:'wx',mode:0o640});renameSync(temporary,target);}finally{if(existsSync(temporary))unlinkSync(temporary);}return{uri:this.uri(key),key,size:body.byteLength,sha256};}
	async putFile(key:string,path:string){key=artifactKey(key);const source=lstatSync(path);if(source.isSymbolicLink()||!source.isFile())throw new Error('Artifact source is not a regular file.');const sha256=await fileDigest(path),target=this.path(key);this.directories(target);if(existsSync(target)){const current=this.inspect(key);if(current.sha256!==sha256||current.size!==source.size)throw new Error('Immutable artifact already exists with different content.');return current;}const temporary=`${target}.treeai-${randomUUID()}`;try{copyFileSync(path,temporary);renameSync(temporary,target);}finally{if(existsSync(temporary))unlinkSync(temporary);}return{uri:this.uri(key),key,size:source.size,sha256};}
	async bytes(uriOrKey:string){const key=this.key(uriOrKey),path=this.path(key),info=lstatSync(path);if(info.isSymbolicLink()||!info.isFile())throw new Error('Artifact is not a regular file.');return readFileSync(path);}
	async head(uriOrKey:string){return this.inspect(this.key(uriOrKey));}
	async list(prefix=''){const normalized=prefix?artifactKey(prefix.replace(/\/$/u,'')):'';const start=normalized?this.path(normalized):this.root;if(!existsSync(start))return[];const files:string[]=[];const walk=(directory:string)=>{for(const name of readdirSync(directory)){const path=resolve(directory,name),info=lstatSync(path);if(info.isSymbolicLink())throw new Error('Artifact store contains a symlink.');if(info.isDirectory())walk(path);else if(info.isFile())files.push(relative(this.root,path).split(sep).join('/'));}};const info=lstatSync(start);if(info.isDirectory())walk(start);else files.push(normalized);return Promise.all(files.sort().map((key)=>this.head(key)));}
}

export class R2ArtifactRepository implements ArtifactRepository{
	private readonly storage:ArtifactStore;
	constructor(readonly storeId:string,readonly bucket:string,options:S3ClientConfig,readonly legacyBuckets:string[]=[]){this.storage=new ArtifactStore(bucket,{...options,region:'auto',forcePathStyle:true,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});}
	uri(key:string){return artifactUri(this.storeId,key);}
	key(uri:string){return resolveArtifactKey(uri,this.storeId,this.legacyBuckets);}
	async put(key:string,body:Uint8Array,contentType?:string){key=artifactKey(key);const sha256=digest(body);try{const current=await this.head(key);if(current.sha256!==sha256||current.size!==body.byteLength)throw new Error('Immutable artifact already exists with different content.');return current;}catch(error){if(!isNotFound(error))throw error;}const value=await this.storage.put(key,body,contentType);return{...value,uri:this.uri(key),key};}
	async putFile(key:string,path:string,contentType?:string){key=artifactKey(key);const source=lstatSync(path);if(source.isSymbolicLink()||!source.isFile())throw new Error('Artifact source is not a regular file.');const sha256=await fileDigest(path);try{const current=await this.head(key);if(current.sha256!==sha256||current.size!==source.size)throw new Error('Immutable artifact already exists with different content.');return current;}catch(error){if(!isNotFound(error))throw error;}const value=await this.storage.putFile(key,path,sha256,contentType);return{...value,uri:this.uri(key),key};}
	async bytes(uriOrKey:string){return this.storage.bytes(this.key(uriOrKey));}
	async head(uriOrKey:string){const key=this.key(uriOrKey),value=await this.storage.head(key),sha256=value.Metadata?.sha256;if(!sha256)throw new Error('Remote artifact has no SHA-256 metadata.');return{uri:this.uri(key),key,size:value.ContentLength??0,sha256};}
	async list(prefix=''){const keys:string[]=[];let continuationToken:string|undefined;do{const result=await this.storage.client.send(new ListObjectsV2Command({Bucket:this.bucket,Prefix:prefix||undefined,ContinuationToken:continuationToken}));keys.push(...(result.Contents??[]).flatMap((item)=>item.Key?[item.Key]:[]));continuationToken=result.IsTruncated?result.NextContinuationToken:undefined;}while(continuationToken);return Promise.all(keys.sort().map((key)=>this.head(key)));}
}
