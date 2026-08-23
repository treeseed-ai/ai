import {cpSync,lstatSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {basename,resolve} from 'node:path';

function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}

const source=resolve(process.argv[2]??'assets');
const destination=resolve(process.argv[3]??'published-assets');
assert(source!==destination,'Source and destination must differ.');
rmSync(destination,{recursive:true,force:true});
mkdirSync(destination,{recursive:true,mode:0o750});

const names=new Map<string,string>();
for(const entry of readdirSync(source,{recursive:true,withFileTypes:true})){
  assert(!entry.isSymbolicLink(),`Release asset cannot be a symlink: ${resolve(entry.parentPath,entry.name)}`);
  if(!entry.isFile())continue;
  const path=resolve(entry.parentPath,entry.name);
  assert(lstatSync(path).isFile(),`Release asset must be a regular file: ${path}`);
  if(entry.name==='SHA256SUMS'||entry.name==='SHA256SUMS.asc')continue;
  const name=basename(path);
  const prior=names.get(name);
  assert(!prior,`Duplicate published release asset name ${name}: ${prior} and ${path}`);
  names.set(name,path);
}
assert(names.size>0,'No release assets were found.');
for(const [name,path] of [...names].sort(([left],[right])=>left.localeCompare(right))){
  cpSync(path,resolve(destination,name),{errorOnExist:true});
}
process.stdout.write(`${JSON.stringify({status:'ready',assets:names.size,destination})}\n`);
