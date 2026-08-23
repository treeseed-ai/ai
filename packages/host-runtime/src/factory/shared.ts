import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

export const version = '0.7.0';
export const configRoot = '/etc/treeseed-ai/host-runtime/factory';
export const stateRoot = '/var/lib/treeseed-ai/host-runtime/factory';
export const publicCa = '/etc/ssl/certs/treeseed-ai-factory-development-ca.pem';
export const installedFactory = '/usr/lib/treeseed-ai/factory';
export const products = ['inference', 'training'] as const;
export const roles = ['inference-api','inference-manager','inference-vllm','inference-evaluator','inference-migrations',
  'training-api','training-manager','axolotl-worker','marker-worker','artifact-worker','training-migrations'] as const;
export type Product = typeof products[number];

export function run(file: string, args: string[], stdio: 'pipe' | 'inherit' = 'inherit', env?: NodeJS.ProcessEnv, cwd?:string) {
  const output=execFileSync(file, args, { encoding: 'utf8', stdio, timeout: 3_600_000, env: env ?? process.env, cwd });
  return typeof output==='string'?output.trim():'';
}
export function requireRoot() { if (process.getuid?.() !== 0) throw new Error('This command must run as root.'); }
export function option(name: string) {
  const direct = process.argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined;
}
export function options(name: string) {
  return process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1] ?? '']
    : value.startsWith(`${name}=`) ? [value.slice(name.length + 1)] : []).filter(Boolean);
}
export function sourceRoot() { return resolve(option('--source') ?? process.env.AI_FACTORY_SOURCE ?? process.cwd()); }
export function deploymentMode(){const requested=process.env.TREEAI_DEPLOYMENT_MODE;if(requested&&requested!=='development'&&requested!=='published')throw new Error('TREEAI_DEPLOYMENT_MODE must be development or published.');if(requested)return requested;if(option('--source')||process.env.AI_FACTORY_SOURCE)return'development';const client='/etc/treeseed-ai/treeai/config.json';if(existsSync(client)){const mode=(JSON.parse(readFileSync(client,'utf8'))as{deploymentMode?:string}).deploymentMode;if(mode==='development'||mode==='published')return mode;}return'published';}
export function credential(id: string, scopes: string[]) {
  const secret = randomBytes(32).toString('base64url'), salt = randomBytes(16).toString('hex');
  return { plain: `ak_${id}_${secret}`, record: { id, hash: `scrypt:${salt}:${scryptSync(secret, salt, 32).toString('hex')}`, scopes, revoked: false } };
}
export function detectedSans(additional = options('--san')) {
  if (additional.some((value) => !/^[a-z0-9.:-]+$/iu.test(value))) throw new Error('Additional SANs may contain only host-name or IP-address characters.');
  const addresses = Object.values(networkInterfaces()).flat().filter((item): item is NonNullable<typeof item> => Boolean(item && !item.internal)).map((item) => item.address);
  return [...new Set([hostname(), 'localhost', '127.0.0.1', ...addresses, ...additional])].sort();
}
export function digest(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
export function treeDigest(root: string) {
  const ignored = new Set(['.git','.artifacts','node_modules','dist','coverage','__pycache__']);
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => ignored.has(entry.name) ? [] : entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  const hash = createHash('sha256');
  for (const file of walk(root).sort()) { hash.update(file.slice(root.length)); hash.update(readFileSync(file)); }
  return hash.digest('hex');
}
export function fileMode(path: string) { return statSync(path).mode & 0o777; }
export function setProductEnvironment(product:Product,name:string,value:string){const path=`/etc/treeseed-ai/${product}/environment`,content=readFileSync(path,'utf8'),lines=content.split('\n').filter((line)=>line&&!line.startsWith(`${name}=`));lines.push(`${name}=${value}`);const next=`${lines.join('\n')}\n`;if(next===content)return;const temporary=`${path}.tmp-${process.pid}`;writeFileSync(temporary,next,{mode:0o640});renameSync(temporary,path);run('chown',[`root:treeseed-ai-${product}`,path]);}
export function prepareRuntimeDirectory(product:Product,configureGroup=false){const group=`treeseed-ai-${product}`,record=run('getent',['group',group],'pipe'),gid=record.split(':')[2];if(!gid||!/^[0-9]+$/u.test(gid))throw new Error(`Cannot resolve runtime group ${group}.`);const path=`/run/treeseed-ai/${product}`;mkdirSync(path,{recursive:true,mode:0o770});chmodSync(path,0o770);run('chown',[`root:${group}`,path]);if(configureGroup)setProductEnvironment(product,'RUNTIME_GID',gid);return gid;}
export function productCompose(product: Product, args: string[], stdio: 'pipe' | 'inherit' = 'inherit') {
  const base = `/usr/lib/treeseed-ai/${product}`;
  return run('docker', ['compose','--env-file',`/etc/treeseed-ai/${product}/environment`,'-f',`${base}/compose.yml`,'-f',`${base}/factory.override.yml`,...args],stdio);
}
export function gateway(args: string[]) { return run('docker', ['compose','--env-file',`${configRoot}/environment`,'-f',`${installedFactory}/compose.yml`,...args]); }
