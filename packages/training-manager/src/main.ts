#!/usr/bin/env node
import { httpHandler, JobWorker, PostgresJobRepository, reconcileCompose, requiredEnv } from '@ai-platform/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Pool } from 'pg';
import type { JobHandler } from '@ai-platform/common';

const command = process.argv[2] ?? 'worker';
const gpuTypes = new Set(['document.process', 'training.qlora']);
const modeFile = process.env.AI_FACTORY_MODE_FILE;
const statusFile = process.env.AI_FACTORY_STATUS_FILE;

function factoryMode() {
  if (!modeFile) return 'sleep';
  try { return JSON.parse(readFileSync(modeFile, 'utf8')).mode as string; }
  catch { return 'degraded'; }
}

function writeStatus(active: number,type='training.qlora') {
  if (!statusFile) return;
  mkdirSync(dirname(statusFile), { recursive: true });
  const temporary = `${statusFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ activeGpuJobs: gpuTypes.has(type)?active:0, updatedAt: new Date().toISOString() })}\n`);
  renameSync(temporary, statusFile);
}
function qloraHandler(axolotl:string,artifact:string):JobHandler{return async(job,signal,progress)=>{if(typeof(job.request as any).baseModelRevision!=='string')throw new Error('baseModelRevision is required.');await progress(.02);const train=await fetch(`${axolotl}/train`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:job.id,type:job.type,input:job.request}),signal});if(!train.ok)throw new Error(`Axolotl worker returned ${train.status}: ${await train.text()}`);const trained=await train.json()as{resultManifest:string};await progress(.85);const exported=await fetch(`${artifact}/export-adapter`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:job.id,type:'artifact.export-adapter',input:{...(job.request as object),adapterResultUri:trained.resultManifest,createdAt:new Date().toISOString()}}),signal});if(!exported.ok)throw new Error(`Artifact worker returned ${exported.status}: ${await exported.text()}`);await progress(.98);return((await exported.json())as{resultManifest:string}).resultManifest;};}

if (command === 'plan' || command === 'apply') {
  const result = await reconcileCompose({
    composeFile: process.env.COMPOSE_FILE ?? '/usr/lib/treeseed-ai/training/compose.yml',
    project: 'treeseed-ai-training', action: command,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const jobs = new PostgresJobRepository(new Pool({ connectionString: requiredEnv('DATABASE_URL') }));
  const marker = process.env.MARKER_URL ?? 'http://marker:8080';
  const axolotl = process.env.AXOLOTL_URL ?? 'http://axolotl:8080';
  const artifact = process.env.ARTIFACT_URL ?? 'http://artifact:8080';
  const handlers = {
    'document.process': httpHandler(`${marker}/process`),
    'dataset.prepare': httpHandler(`${artifact}/dataset`),
	'experience.register': httpHandler(`${artifact}/experience-register`),
	'experience.prepare': httpHandler(`${artifact}/experience`),
    'training.qlora': qloraHandler(axolotl,artifact),
    'artifact.verify': httpHandler(`${artifact}/verify`),
    'archive.create': httpHandler(`${artifact}/archive`),
    'archive.restore': httpHandler(`${artifact}/restore`),
  };
  const worker = new JobWorker({
    jobs, workerId: `training-manager-${process.pid}`, handlers,
    enabledTypes: () => factoryMode() === 'sleep'
      ? Object.keys(handlers)
      : Object.keys(handlers).filter((type) => !gpuTypes.has(type)),
    onActiveChange: writeStatus,
  });
  writeStatus(0);
  process.on('SIGTERM', () => worker.stop());
  await worker.run();
}
