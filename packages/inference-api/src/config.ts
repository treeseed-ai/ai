import { numberEnv,parseBootstrapKeys,requiredEnv } from '@ai-platform/common';

export interface InferenceConfig {
	version: string; controlHost: string; controlPort: number; inferenceHost: string; inferencePort: number;
	databaseUrl: string; rawVllmUrl: string; publicModel: string; sourceModel: string;
	apiKeys: ReturnType<typeof parseBootstrapKeys>;
}

export function inferenceConfig(env = process.env): InferenceConfig {
	return {
		version: env.AI_VERSION ?? '0.6.1', controlHost: env.CONTROL_HOST ?? '127.0.0.1', controlPort: numberEnv('CONTROL_PORT', 4770, env),
		inferenceHost: env.INFERENCE_HOST ?? '0.0.0.0', inferencePort: numberEnv('INFERENCE_PORT', 4771, env),
		databaseUrl: requiredEnv('DATABASE_URL', env), rawVllmUrl: env.VLLM_URL ?? 'http://vllm:8000',
		publicModel: env.PUBLIC_MODEL ?? 'local-model', sourceModel: env.SOURCE_MODEL ?? 'Qwen/Qwen3.5-4B', apiKeys: parseBootstrapKeys(env.AI_API_KEYS),
	};
}
