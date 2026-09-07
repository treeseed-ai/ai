import{FilesystemArtifactRepository,R2ArtifactRepository,storageCustodyFromEnvironment,type ArtifactRepository}from'@ai-platform/common';

export type TrainingArtifactConfig={backend:'filesystem';root:string;storeId:string}|{backend:'r2';storeId:'managed-training'};
export function trainingArtifacts(config:TrainingArtifactConfig):ArtifactRepository{
	if(config.backend==='filesystem')return new FilesystemArtifactRepository(config.storeId,config.root);
	return new R2ArtifactRepository(config.storeId,storageCustodyFromEnvironment());
}
export async function verifyArtifacts(repository:ArtifactRepository){const key='.treeai-readiness/training-api-v1',expected=new TextEncoder().encode('treeai-artifact-repository-capability-v1'),stored=await repository.put(key,expected);const actual=await repository.bytes(stored.uri);if(Buffer.compare(Buffer.from(actual),Buffer.from(expected))!==0)throw new Error('Artifact repository capability probe returned different bytes');}
