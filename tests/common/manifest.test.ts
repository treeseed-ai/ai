import {generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {describe,expect,it} from 'vitest';
import {signManifest,verifyManifest} from '../../packages/common/src/manifest.ts';
import type {ArtifactManifest} from '../../packages/common/src/types.ts';

const pythonSigner=`import base64,json,os,sys
from cryptography.hazmat.primitives import serialization
sys.path.insert(0,"workers/artifact")
from canonical_json import canonical,legacy_canonical
k=serialization.load_pem_private_key(base64.b64decode(os.environ["KEY"]),None)
m=json.loads(os.environ["MANIFEST"]);legacy=os.environ.get("LEGACY")=="1"
if not legacy:m["evaluations"][0]["baseValue"]=2.0
payload=legacy_canonical(m) if legacy else canonical(m)
m["signature"]=base64.b64encode(k.sign(payload)).decode();print(json.dumps(m))`;

function pythonManifest(legacy=false){
	const {privateKey,publicKey}=generateKeyPairSync('ed25519');
	const unsigned={schemaVersion:'ai.artifact/v3',artifactId:'python-adapter',artifactType:'lora-adapter',createdAt:'2026-08-24T00:00:00.000Z',objects:[],evaluations:[{schemaVersion:'ai.library-likelihood-evaluation/v1',metric:'completion-negative-log-likelihood',baseValue:2,candidateValue:legacy?1.75:1.25e-7}],provenance:{job:'python'},signingKeyId:'key-1'};
	const result=spawnSync('python3',['-c',pythonSigner],{encoding:'utf8',env:{...process.env,KEY:Buffer.from(privateKey.export({format:'pem',type:'pkcs8'})).toString('base64'),MANIFEST:JSON.stringify(unsigned),LEGACY:legacy?'1':'0'}});
	expect(result.status).toBe(0);return{manifest:JSON.parse(result.stdout)as ArtifactManifest,publicKey};
}

describe('artifact exchange manifests',()=>{
	it('signs canonical content and detects changes',()=>{const{privateKey,publicKey}=generateKeyPairSync('ed25519');for(const schemaVersion of['ai.artifact/v1','ai.artifact/v2','ai.artifact/v3']as const){const manifest=signManifest({schemaVersion,artifactId:'adapter-1',artifactType:'lora-adapter',createdAt:'2026-08-21T00:00:00.000Z',baseModel:{id:'model',revision:'sha'},adapter:{format:'peft',architecture:'qwen'},objects:[{uri:'s3://bucket/a',size:1,sha256:'a'.repeat(64)}],provenance:{job:'1'},signingKeyId:'key-1'},privateKey);expect(verifyManifest(manifest,publicKey)).toBe(true);expect(verifyManifest({...manifest,artifactId:'changed'},publicKey)).toBe(false);}});
	it('verifies Python v2 canonical values including whole and exponent floats',()=>{const value=pythonManifest();expect(verifyManifest(value.manifest,value.publicKey)).toBe(true);});
	it('retains verification for immutable legacy Python manifests',()=>{const value=pythonManifest(true);expect(verifyManifest(value.manifest,value.publicKey)).toBe(true);});
});
