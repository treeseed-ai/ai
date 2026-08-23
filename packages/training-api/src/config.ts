import { numberEnv,parseBootstrapKeys,requiredEnv } from '@ai-platform/common';
export function trainingConfig(env=process.env){return{version:env.AI_VERSION??'0.7.0',host:env.CONTROL_HOST??'127.0.0.1',port:numberEnv('CONTROL_PORT',4780,env),databaseUrl:requiredEnv('DATABASE_URL',env),apiKeys:parseBootstrapKeys(env.AI_API_KEYS)};}
