#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { postgresApiKeyResolver,PostgresJobRepository } from '@ai-platform/common';
import { Pool } from 'pg';
import { createInferenceControlApp } from './app.js';
import { inferenceConfig } from './config.js';
import { createInferenceGateway } from './gateway.js';
import { createArtifactImporter } from './artifacts.js';

const config=inferenceConfig(); const pool=new Pool({connectionString:config.databaseUrl}); const jobs=new PostgresJobRepository(pool);
const resolveKey=postgresApiKeyResolver(pool,config.apiKeys);
serve({fetch:createInferenceControlApp({jobs,resolveKey,version:config.version,ready:async()=>{await pool.query('SELECT 1');return true;},importArtifact:process.env.ARTIFACT_SOURCE_REGISTRY?createArtifactImporter(pool):undefined,currentDeployment:async()=>{const value=await pool.query(`SELECT d.id,d.candidate_id AS "candidateId",d.previous_id AS "previousId",d.created_at AS "createdAt" FROM deployments d WHERE d.active=true ORDER BY d.created_at DESC LIMIT 1`);return value.rows[0]??null;},candidate:async(id)=>{const value=await pool.query('SELECT id,manifest_uri AS "manifestUri",manifest,status,created_at AS "createdAt" FROM candidates WHERE id=$1',[id]);return value.rows[0]??null;}}).fetch,hostname:config.controlHost,port:config.controlPort});
serve({fetch:createInferenceGateway({...config,resolveKey,resolveModel:async()=>{const result=await pool.query(`SELECT c.id::text AS model FROM deployments d JOIN candidates c ON c.id=d.candidate_id WHERE d.active=true ORDER BY d.created_at DESC LIMIT 1`);return result.rows[0]?.model??config.sourceModel;}}).fetch,hostname:config.inferenceHost,port:config.inferencePort});
process.stdout.write(JSON.stringify({service:'inference-api',controlPort:config.controlPort,inferencePort:config.inferencePort})+'\n');
