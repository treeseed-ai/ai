import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { readState, writeState } from './state.js';

const execute = promisify(execFile);
const inference = process.env.INFERENCE_COMPOSE ?? '/usr/lib/treeseed-ai/inference/compose.yml';
const training = process.env.TRAINING_COMPOSE ?? '/usr/lib/treeseed-ai/training/compose.yml';
const inferenceEnv = process.env.INFERENCE_ENV ?? '/etc/treeseed-ai/inference/environment';
const trainingEnv = process.env.TRAINING_ENV ?? '/etc/treeseed-ai/training/environment';
const gatewayCompose=process.env.FACTORY_GATEWAY_COMPOSE??'/usr/lib/treeseed-ai/factory/compose.yml';const factoryEnv=process.env.FACTORY_ENV??'/etc/treeseed-ai/host-runtime/factory/environment';
const receiptRoot = process.env.AI_FACTORY_RECEIPT_ROOT ?? '/var/lib/treeseed-ai/host-runtime/factory/transitions';

async function compose(file: string, environment: string, args: string[]) {
  const overlay = file.replace('compose.yml', 'factory.override.yml');
  return execute('docker', ['compose', '--env-file', environment, '-f', file,
    ...(existsSync(overlay) ? ['-f', overlay] : []), ...args], { timeout: 900_000 });
}
function active(path: string) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return Number(value.active ?? value.activeGpuJobs ?? 0);
  } catch { return 0; }
}
async function waitIdle(path: string, seconds: number) {
  for (let elapsed = 0; elapsed < seconds; elapsed++) {
    if (active(path) === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export interface Transition {
  schemaVersion: 'ai.factory-transition/v1'; id: string; target: 'awake' | 'sleep';
  state: 'running' | 'succeeded' | 'failed'; createdAt: string; completedAt?: string; error?: string;
}
const transitions = new Map<string, Transition>();
const keys = new Map<string, string>();
function persist(item: Transition, idempotencyKey: string) {
  mkdirSync(receiptRoot, { recursive: true });
  writeFileSync(`${receiptRoot}/${item.id}.json`, `${JSON.stringify({ ...item, idempotencyKey }, null, 2)}\n`, { mode: 0o640 });
}
function receipt(id:string){try{return JSON.parse(readFileSync(`${receiptRoot}/${id}.json`,'utf8'))as Transition&{idempotencyKey?:string};}catch{return undefined;}}
function receiptForKey(key:string){try{for(const file of readdirSync(receiptRoot)){const value=receipt(file.replace(/\.json$/u,''));if(value?.idempotencyKey===key)return value;}}catch{}return undefined;}
export function transitionById(id: string) { return transitions.get(id)??receipt(id); }
export function failInterruptedTransition(id:string){const value=receipt(id);if(value?.state==='running'){value.state='failed';value.error='Transition was interrupted by coordinator restart.';value.completedAt=new Date().toISOString();persist(value,value.idempotencyKey??`interrupted-${id}`);}}
export async function currentServices() {
  const statuses:Record<string,unknown>={};for(const[name,file,environment]of[['inference',inference,inferenceEnv],['training',training,trainingEnv],['gateway',gatewayCompose,factoryEnv]]as const){try{const{stdout}=await compose(file,environment,['ps','--format','json']);statuses[name]=stdout.trim().split('\n').filter(Boolean).map(line=>{const value=JSON.parse(line)as{Service:string;State:string;Health?:string;Status:string;ExitCode?:number};return{service:value.Service,state:value.State,health:value.Health||undefined,status:value.Status,exitCode:value.ExitCode};});}catch(error){statuses[name]={error:error instanceof Error?error.message:String(error)};}}
  return { mode: readState().mode, active:{inference:active('/run/treeseed-ai/inference/status.json'),training:active('/run/treeseed-ai/training/status.json')}, services:statuses };
}
export function requestTransition(target: 'awake' | 'sleep', idempotencyKey: string) {
  const prior = keys.get(idempotencyKey);
  if (prior) return transitions.get(prior)!;
  const persisted=receiptForKey(idempotencyKey);if(persisted)return persisted;
  const transition: Transition = { schemaVersion: 'ai.factory-transition/v1', id: randomUUID(), target, state: 'running', createdAt: new Date().toISOString() };
  keys.set(idempotencyKey, transition.id); transitions.set(transition.id, transition); persist(transition, idempotencyKey);
  void runTransition(transition, idempotencyKey);
  return transition;
}
async function runTransition(item: Transition, idempotencyKey: string) {
  const previousMode = readState().mode;
  let lifecycleChanged = false;
  try {
    const current = readState();
    if (current.mode !== item.target) {
      writeState({ schemaVersion: 'ai.factory-state/v1', mode: item.target === 'awake' ? 'transitioning_awake' : 'transitioning_sleep', updatedAt: new Date().toISOString(), transitionId: item.id });
      if (item.target === 'sleep') {
        if (!await waitIdle('/run/treeseed-ai/inference/status.json', 120)) throw new Error('Inference did not drain within 120 seconds.');
        await compose(inference, inferenceEnv, ['stop', 'vllm']);
        lifecycleChanged = true;
        await compose(training, trainingEnv, ['up', '-d', '--wait', '--wait-timeout', '600', 'marker', 'axolotl']);
      } else {
        if (!await waitIdle('/run/treeseed-ai/training/status.json', 300)) throw new Error('GPU training did not drain within 300 seconds.');
        await compose(training, trainingEnv, ['stop', 'marker', 'axolotl']);
        lifecycleChanged = true;
        await compose(inference, inferenceEnv, ['up', '-d', '--wait', '--wait-timeout', '900', 'vllm']);
        await warmInference();
      }
      writeState({ schemaVersion: 'ai.factory-state/v1', mode: item.target, updatedAt: new Date().toISOString(), transitionId: item.id });
    }
    item.state = 'succeeded';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeMode = !lifecycleChanged && (previousMode === 'awake' || previousMode === 'sleep') ? previousMode : 'degraded';
    writeState({ schemaVersion: 'ai.factory-state/v1', mode: safeMode, updatedAt: new Date().toISOString(), transitionId: item.id, error: message });
    item.state = 'failed'; item.error = message;
  } finally { item.completedAt = new Date().toISOString(); persist(item, idempotencyKey); }
}
async function warmInference() {
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      await compose(inference, inferenceEnv, ['exec', '-T', 'vllm', 'python3', '-c',
        "import json,urllib.request; body=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':'Reply with ready.'}],'max_tokens':8}).encode(); r=urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=body,headers={'content-type':'application/json'}); urllib.request.urlopen(r,timeout=120).read()"]);
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 2000)); }
  }
  throw new Error('vLLM warm-up did not become healthy.');
}
export async function reconcile() {
  const state = readState();
  if (!existsSync(inference) || !existsSync(training)) throw new Error('Both product Compose files must be installed.');
  const inferenceBase=['postgres','minio','minio-init','migrations','evaluator','manager','api'];const trainingBase=['postgres','minio','minio-init','migrations','artifact','manager','api'];
  if (state.mode === 'awake'){await compose(training, trainingEnv, ['stop', 'marker', 'axolotl']);await compose(training,trainingEnv,['up','-d','--wait','--wait-timeout','600',...trainingBase]);await compose(inference,inferenceEnv,['up','-d','--wait','--wait-timeout','900',...inferenceBase,'vllm']);await warmInference();}
  else if (state.mode === 'sleep'){await compose(inference, inferenceEnv, ['stop', 'vllm']);await compose(inference,inferenceEnv,['up','-d','--wait','--wait-timeout','600',...inferenceBase]);await compose(training,trainingEnv,['up','-d','--wait','--wait-timeout','900',...trainingBase,'marker','axolotl']);}
  else throw new Error(`Cannot automatically reconcile ${state.mode}.`);
  await compose(gatewayCompose,factoryEnv,['up','-d','gateway']);
  return state;
}
