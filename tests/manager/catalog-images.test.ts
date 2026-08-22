import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';
import{validateCatalog}from'../../packages/manager/src/core/catalog.js';

describe('cataloged upstream runtime images',()=>{
  it('tracks every production Compose dependency by digest',()=>{
    const catalog=validateCatalog(JSON.parse(readFileSync('release/catalog.json','utf8')));
    expect(catalog.runtimeImages.map(image=>image.id)).toEqual(expect.arrayContaining(['caddy','postgres','minio','minio-client','open-webui']));
    for(const image of catalog.runtimeImages)expect(image.reference).toContain(`@${image.digest}`);
  });
});
