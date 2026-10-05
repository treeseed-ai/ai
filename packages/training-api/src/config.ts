import { numberEnv,parseBootstrapKeys,readAiDatabaseUrl } from '@ai-platform/common';
import type{TrainingArtifactConfig}from'./artifact-storage.js';
export function trainingArtifactConfig(env=process.env):TrainingArtifactConfig{
	const backend=env.ARTIFACT_BACKEND??'filesystem';
	if(!['filesystem','r2'].includes(backend))throw new Error('ARTIFACT_BACKEND must be filesystem or r2');
	if(backend==='r2'&&env.ARTIFACT_STORE_ID!=='managed-training')throw new Error('R2 storage requires a managed training allocation');
	return backend==='r2'?{backend,storeId:'managed-training'}:{backend:'filesystem',root:env.ARTIFACT_ROOT??'/artifacts',storeId:env.ARTIFACT_STORE_ID??'managed-training'};
}
export function trainingConfig(env=process.env){
	const artifacts=trainingArtifactConfig(env);
	return{version:env.AI_VERSION??'0.11.0',host:env.CONTROL_HOST??'127.0.0.1',port:numberEnv('CONTROL_PORT',4780,env),databaseUrl:readAiDatabaseUrl('training',env),apiKeys:parseBootstrapKeys(env.AI_API_KEYS),artifacts};
}
