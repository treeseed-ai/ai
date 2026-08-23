import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

function read(path:string){return JSON.parse(readFileSync(path,'utf8'))as Record<string,unknown>}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message)}

const root=resolve(process.argv[2]??'release-assets');
const release=read('release/manifest.json')as unknown as{version:string;dockerNamespace:string;images:string[]};
const manifest=read(resolve(root,'image-manifest.json'))as unknown as{schemaVersion:string;version:string;namespace:string;images:Record<string,{repository:string;digest:string;tag:string;buildIdentity?:string;disposition?:string;firstBuiltVersion?:string}>};
assert(['treeai.images/v1','treeai.images/v2'].includes(manifest.schemaVersion),'Invalid image metadata schema.');
assert(manifest.version===release.version,'Image metadata version does not match the release.');
assert(manifest.namespace===release.dockerNamespace,'Image metadata namespace does not match the release.');
assert(JSON.stringify(Object.keys(manifest.images).sort())===JSON.stringify([...release.images].sort()),'Image metadata roles are incomplete.');
for(const role of release.images){
  const image=manifest.images[role];
  assert(image.repository===`${release.dockerNamespace}/${role}`,`Invalid repository for ${role}.`);
  if(manifest.schemaVersion==='treeai.images/v1')assert(image.tag===release.version,`Invalid tag for ${role}.`);
  else{assert(/^sha256:[a-f0-9]{64}$/u.test(image.buildIdentity??''),`Invalid build identity for ${role}.`);assert(['built','reused'].includes(image.disposition??''),`Invalid disposition for ${role}.`);assert(/^\d+\.\d+\.\d+$/u.test(image.firstBuiltVersion??''),`Invalid first-built version for ${role}.`);assert(image.tag===image.firstBuiltVersion,`Published tag must identify the first build of ${role}.`);if(image.disposition==='built')assert(image.tag===release.version,`New build tag differs for ${role}.`);}
  assert(/^sha256:[a-f0-9]{64}$/u.test(image.digest),`Invalid digest for ${role}.`);
  const sbom=read(resolve(root,'sboms',`${role}.spdx.json`));
  assert(typeof sbom.spdxVersion==='string'&&sbom.spdxVersion.startsWith('SPDX-'),'Invalid SPDX document.');
  const report=read(resolve(root,'vulnerabilities',`${role}.json`));
  assert(Array.isArray(report.Results),'Invalid vulnerability report.');
}
assert(JSON.stringify(read(resolve(root,'compatibility-matrix.json')))===JSON.stringify(read('release/manifest.json')),'Compatibility matrix differs from the release manifest.');
assert(JSON.stringify(read(resolve(root,'vulnerability-exceptions.json')))===JSON.stringify(read('release/vulnerability-exceptions.json')),'Vulnerability policy differs from the release policy.');
process.stdout.write(`${JSON.stringify({status:'ready',version:release.version,images:release.images.length})}\n`);
