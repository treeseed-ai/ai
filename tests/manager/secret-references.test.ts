import{readFileSync}from'node:fs';
import{describe,expect,it}from'vitest';
import{finalizeConfiguration,validatePlatformConfiguration}from'../../packages/common/src/platform/index.js';

describe('external secret references',()=>{
  it('allows protected file paths without allowing credential assignments',()=>{
    const value=JSON.parse(readFileSync('config/platform.default.json','utf8'));
    value.secrets.database={provider:'file',reference:'/run/secrets/external-postgresql'};
    expect(validatePlatformConfiguration(finalizeConfiguration(value)).secrets.database.reference).toContain('/run/secrets/');
    value.secrets.database.reference='password=exposed';
    expect(()=>validatePlatformConfiguration(finalizeConfiguration(value))).toThrow(/provider reference/u);
  });
});
