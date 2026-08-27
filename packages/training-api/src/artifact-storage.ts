import{FilesystemArtifactRepository,R2ArtifactRepository,type ArtifactRepository}from'@ai-platform/common';
import{readFileSync}from'node:fs';

export type TrainingArtifactConfig={backend:'filesystem';root:string;storeId:string;legacyBuckets:string[]}|{backend:'r2';endpoint:string;bucket:string;accessKeyFile:string;secretKeyFile:string;storeId:string;legacyBuckets:string[]};
function secret(path:string){const value=readFileSync(path,'utf8').trim();if(!value)throw new Error(`Artifact credential file is empty: ${path}`);return value;}
export function trainingArtifacts(config:TrainingArtifactConfig):ArtifactRepository{
	if(config.backend==='filesystem')return new FilesystemArtifactRepository(config.storeId,config.root,config.legacyBuckets);
	const endpoint=new URL(config.endpoint);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('R2 endpoint must be an HTTPS origin');
	return new R2ArtifactRepository(config.storeId,config.bucket,{endpoint:config.endpoint,credentials:{accessKeyId:secret(config.accessKeyFile),secretAccessKey:secret(config.secretKeyFile)}},config.legacyBuckets);
}
export async function verifyArtifacts(repository:ArtifactRepository){const key='.treeai-readiness/training-api-v1',expected=new TextEncoder().encode('treeai-artifact-repository-capability-v1'),stored=await repository.put(key,expected);const actual=await repository.bytes(stored.uri);if(Buffer.compare(Buffer.from(actual),Buffer.from(expected))!==0)throw new Error('Artifact repository capability probe returned different bytes');}
