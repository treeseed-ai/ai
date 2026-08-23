import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';
import{validateCatalog}from'../../packages/manager/src/core/catalog.js';
import{catalogImageEntries}from'../../scripts/release/catalog-images.js';

describe('cataloged upstream runtime images',()=>{
  it('tracks every production Compose dependency by digest',()=>{
    const catalog=validateCatalog(JSON.parse(readFileSync('release/catalog.json','utf8')));
    expect(catalog.packageSet).toBe('all');
    expect(catalog.runtimeImages.map(image=>image.id)).toEqual(expect.arrayContaining(['caddy','postgres','minio','minio-client','open-webui']));
    for(const image of catalog.runtimeImages)expect(image.reference).toContain(`@${image.digest}`);
  });
  it('declares package and image delivery as independent dimensions',()=>{
    const catalog=validateCatalog(JSON.parse(readFileSync('release/catalog.json','utf8')));
    expect(catalog.imagePolicy).toEqual(expect.objectContaining({mode:'package-only',requiredLocalImages:[]}));
    const invalid=structuredClone(catalog);
    invalid.imagePolicy={...invalid.imagePolicy,mode:'local-images-required',requiredLocalImages:[]};
    expect(()=>validateCatalog(invalid)).toThrow(/image delivery policy/u);
  });
  it('omits new local-only roles from package-only bridges',()=>{const digest=`sha256:${'a'.repeat(64)}`,roles=['inference-api','lab-web-tool-proxy'],manifest={'inference-api':{repository:'treeseed/inference-api',digest,buildIdentity:digest}},plan={'inference-api':{action:'reused' as const,buildIdentity:digest},'lab-web-tool-proxy':{action:'built' as const,buildIdentity:`sha256:${'b'.repeat(64)}`}};const bridge=catalogImageEntries(roles,manifest,plan,8000004,true,'treeseed');expect(bridge.map(image=>image.role)).toEqual(['inference-api']);expect(bridge.every(image=>image.digest!==`sha256:${'0'.repeat(64)}`)).toBe(true);const full=catalogImageEntries(roles,manifest,plan,8000005,false,'treeseed');expect(full.find(image=>image.role==='lab-web-tool-proxy')).toMatchObject({localBuildOnly:true,digest:`sha256:${'0'.repeat(64)}`});});
});
