import{existsSync,mkdirSync,readFileSync,renameSync,writeFileSync}from'node:fs';import{dirname}from'node:path';
export type FactoryMode='awake'|'sleep'|'transitioning_awake'|'transitioning_sleep'|'degraded';export interface FactoryState{schemaVersion:'ai.factory-state/v1';mode:FactoryMode;updatedAt:string;contextLength?:number;transitionId?:string;error?:string}
export const statePath=process.env.AI_FACTORY_STATE??'/var/lib/treeseed-ai/host-runtime/factory/mode.json';
export function readState(path=statePath):FactoryState{if(!existsSync(path))return{schemaVersion:'ai.factory-state/v1',mode:'awake',updatedAt:new Date(0).toISOString()};return JSON.parse(readFileSync(path,'utf8'))as FactoryState;}
export function writeState(value:FactoryState,path=statePath){mkdirSync(dirname(path),{recursive:true,mode:0o750});const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,`${JSON.stringify(value,null,2)}\n`,{mode:0o640});renameSync(temporary,path);}
