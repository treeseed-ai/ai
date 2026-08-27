import{createHash}from'node:crypto';
import{existsSync,lstatSync,readFileSync,readdirSync,writeFileSync}from'node:fs';
import{matchesGlob,relative,resolve,sep}from'node:path';
import{fileURLToPath}from'node:url';

export interface ImageBuild{dockerfile:string;buildArgs?:Record<string,string>;inputs:string[]}
interface PriorImage{repository:string;digest:string;tag:string;buildIdentity?:string;firstBuiltVersion?:string}
interface InputEntry{path:string;type:'directory'|'file';mode:number}
const patternCache=new Map<string,string[]>();
function ignored(root:string,path:string){
  const ignoreFile=resolve(root,'.dockerignore'),patterns=patternCache.get(root)??(existsSync(ignoreFile)?readFileSync(ignoreFile,'utf8').split(/\r?\n/u).map((item)=>item.trim()).filter((item)=>item&&!item.startsWith('#')):[]);patternCache.set(root,patterns);
  let result=false;
  for(const raw of patterns){const negated=raw.startsWith('!'),pattern=(negated?raw.slice(1):raw).replace(/^\//u,'').replace(/\/$/u,''),variants=pattern.includes('/')?[pattern]:[pattern,`**/${pattern}`];if(variants.some((item)=>matchesGlob(path,item)||matchesGlob(path,`${item}/**`)))result=!negated;}
  return result;
}

function entries(root:string,path:string):InputEntry[]{
  const absolute=resolve(root,path),stat=lstatSync(absolute);
  if(stat.isSymbolicLink())throw new Error(`Build identity input cannot be a symlink: ${path}`);
  if(stat.isFile())return[{path,type:'file',mode:stat.mode&0o777}];
  if(!stat.isDirectory())throw new Error(`Unsupported build identity input: ${path}`);
  const result:InputEntry[]=[{path,type:'directory',mode:stat.mode&0o777}];
  const visit=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const absoluteEntry=resolve(directory,entry.name),entryPath=relative(root,absoluteEntry).split(sep).join('/');if(ignored(root,entryPath))continue;if(entry.isSymbolicLink())throw new Error(`Build identity input cannot be a symlink: ${entryPath}`);if(!entry.isFile()&&!entry.isDirectory())throw new Error(`Unsupported build identity input: ${entryPath}`);result.push({path:entryPath,type:entry.isFile()?'file':'directory',mode:lstatSync(absoluteEntry).mode&0o777});if(entry.isDirectory())visit(absoluteEntry);}};
  visit(absolute);
  return result;
}

function inputFingerprint(root:string,input:string){const hash=createHash('sha256');for(const entry of entries(root,input).sort((left,right)=>left.path.localeCompare(right.path))){hash.update(`${entry.path}\0${entry.type}\0${entry.mode.toString(8)}\0`);if(entry.type==='file'){const content=readFileSync(resolve(root,entry.path));hash.update(`${content.length}\0`);hash.update(content);}hash.update('\0');}return hash.digest('hex');}

export function computeBuildIdentity(role:string,build:ImageBuild,platform:string,root=process.cwd(),cache=new Map<string,string>()){
  const hash=createHash('sha256');
  hash.update(`${JSON.stringify({schemaVersion:'treeai.image-builds/v1',role,platform,dockerfile:build.dockerfile,buildArgs:build.buildArgs??{}})}\n`);
  for(const input of [...build.inputs].sort()){const key=`${root}\0${input}`,fingerprint=cache.get(key)??inputFingerprint(root,input);cache.set(key,fingerprint);hash.update(`${input}\0${fingerprint}\0`);}
  return`sha256:${hash.digest('hex')}`;
}

export function reuseEligible(input:{previousValid:boolean;buildIdentityMatches:boolean}){return input.previousValid&&input.buildIdentityMatches;}

function main(){
  const release=JSON.parse(readFileSync('release/manifest.json','utf8'))as{version:string;dockerNamespace:string;images:string[]};release.version=process.env.TREEAI_RELEASE_VERSION??release.version;
  const builds=JSON.parse(readFileSync('release/image-builds.json','utf8'))as{schemaVersion:string;platform:string;images:Record<string,ImageBuild>};
  const output=resolve(process.argv[2]??'.artifacts/image-plan.json'),priorPath=process.argv[3];
  const prior=priorPath&&existsSync(priorPath)?JSON.parse(readFileSync(priorPath,'utf8'))as{schemaVersion:string;version:string;images:Record<string,PriorImage>}:undefined;
  if(builds.schemaVersion!=='treeai.image-builds/v1'||builds.platform!=='linux/amd64')throw new Error('Invalid image-build configuration.');
  if(JSON.stringify(Object.keys(builds.images).sort())!==JSON.stringify([...release.images].sort()))throw new Error('Image-build roles do not match the release manifest.');
  const images:Record<string,Record<string,unknown>>={};
  const cache=new Map<string,string>();
  for(const role of release.images){
    const build=builds.images[role],buildIdentity=computeBuildIdentity(role,build,builds.platform,process.cwd(),cache),previous=prior?.schemaVersion==='treeai.images/v2'?prior.images[role]:undefined;
		const previousValid=previous?.repository===`${release.dockerNamespace}/${role}`&&/^sha256:[a-f0-9]{64}$/u.test(previous.digest)&&/^sha256:[a-f0-9]{64}$/u.test(previous.buildIdentity??'');
    const reuse=reuseEligible({previousValid:Boolean(previousValid),buildIdentityMatches:previous?.buildIdentity===buildIdentity});
    const tag=process.env.TREEAI_IMAGE_TAG??release.version,promote=process.env.TREEAI_PROMOTE_REUSED==='1';images[role]={role,action:reuse?'reused':'built',buildIdentity:reuse?previous?.buildIdentity:buildIdentity,dockerfile:build.dockerfile,buildArgs:Object.entries(build.buildArgs??{}).map(([key,value])=>`${key}=${value}`).join('\n'),platform:builds.platform,repository:`${release.dockerNamespace}/${role}`,...reuse?{digest:previous.digest,tag:promote?tag:previous.tag,firstBuiltVersion:previous.firstBuiltVersion??previous.tag}:{tag,firstBuiltVersion:release.version}};
  }
  writeFileSync(output,`${JSON.stringify({schemaVersion:'treeai.image-build-plan/v1',version:release.version,previousVersion:prior?.version??null,images},null,2)}\n`);
  process.stdout.write(`${JSON.stringify({status:'ready',built:Object.values(images).filter((item)=>item.action==='built').length,reused:Object.values(images).filter((item)=>item.action==='reused').length})}\n`);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
