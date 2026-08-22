import{execFileSync}from'node:child_process';import{chmodSync,copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync}from'node:fs';import{dirname}from'node:path';import type{CommandResult,SystemAdapter}from'./types.js';
export class NodeSystem implements SystemAdapter{
	exists(path:string){return existsSync(path);}read(path:string){return readFileSync(path,'utf8');}now(){return new Date().toISOString();}uid(){return process.getuid?.()??-1;}
	command(file:string,args:string[]=[]):CommandResult{try{const stdout=execFileSync(file,args,{encoding:'utf8',timeout:120_000,stdio:['ignore','pipe','pipe']});return{code:0,stdout:stdout.trim(),stderr:''};}catch(error:any){return{code:error.status??1,stdout:String(error.stdout??'').trim(),stderr:String(error.stderr??error.message??'').trim()};}}
	mkdir(path:string,mode=0o750){mkdirSync(path,{recursive:true,mode});}writeAtomic(path:string,value:string,mode=0o640){this.mkdir(dirname(path));const temporary=`${path}.tmp-${process.pid}`;writeFileSync(temporary,value,{mode});renameSync(temporary,path);}copy(source:string,target:string,mode=0o640){this.mkdir(dirname(target));copyFileSync(source,target);chmodSync(target,mode);}remove(path:string){rmSync(path,{force:true});}
}
export function commandExists(system:SystemAdapter,name:string){return system.command('sh',['-c',`command -v ${name}`]).code===0;}
