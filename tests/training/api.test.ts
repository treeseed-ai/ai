import { describe, expect, it } from "vitest";
import { hashApiKey, MemoryJobRepository } from "../../packages/common/src/index.ts";
import { createTrainingControlApp, trainingRoutes } from "../../packages/training-api/src/app.ts";
import { objectStoreReadinessError } from "../../packages/training-api/src/readiness.ts";

const record={id:"test",hash:hashApiKey("secret","salt"),scopes:["*"],revoked:false};
const resolveKey=async(id:string)=>id==="test"?record:null;
const headers={authorization:"Bearer ak_test_secret","content-type":"application/json"};

describe("training product",()=>{
	it("declares every route in OpenAPI 3.1.1",async()=>{
		const app=createTrainingControlApp({jobs:new MemoryJobRepository(),resolveKey});
		const document=await(await app.request("/openapi.json")).json()as any;
		expect(document.openapi).toBe("3.1.1");
		for(const route of trainingRoutes)expect(document.paths[route.path.replace(/:([^/]+)/g,"{$1}")][route.method.toLowerCase()]).toBeDefined();
	});
	it("reports dependency readiness without exposing provider errors",async()=>{
		const app=createTrainingControlApp({jobs:new MemoryJobRepository(),resolveKey,ready:async()=>{throw new Error("InvalidAccessKeyId secret-value");}});
		const response=await app.request("/readyz");
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ok:false,error:{code:"dependency_unavailable",message:"A training API dependency is unavailable."}});
	});
	it("classifies only allowlisted object-store errors without provider details",async()=>{
		for(const[name,code]of Object.entries({InvalidAccessKeyId:"object_store_identity_invalid",SignatureDoesNotMatch:"object_store_signature_invalid",AccessDenied:"object_store_access_denied",NoSuchBucket:"object_store_bucket_missing",TimeoutError:"object_store_unavailable"})){
			const provider=new Error(`provider-secret-${name}`);provider.name=name;
			const app=createTrainingControlApp({jobs:new MemoryJobRepository(),resolveKey,ready:async()=>{throw objectStoreReadinessError(provider);}}),response=await app.request("/readyz"),body=await response.json();
			expect(response.status).toBe(503);expect(body).toEqual({ok:false,error:{code,message:"A training API dependency is unavailable."}});expect(JSON.stringify(body)).not.toContain("provider-secret");
		}
	});
	it("classifies redacted HTTP fallbacks",()=>{
		expect(objectStoreReadinessError({$metadata:{httpStatusCode:404}}).code).toBe("object_store_bucket_missing");
		expect(objectStoreReadinessError({$metadata:{httpStatusCode:403}}).code).toBe("object_store_access_denied");
	});
	it("creates PDF and QLoRA jobs without accepting host commands",async()=>{
		const app=createTrainingControlApp({jobs:new MemoryJobRepository(),resolveKey});
		const pdf=await app.request("/v1/documents",{method:"POST",headers,body:JSON.stringify({idempotencyKey:"pdf-1",input:{sourceUri:"s3://input/a.pdf",command:"rm"}})});
		expect(pdf.status).toBe(202);expect(await pdf.json()).toMatchObject({type:"document.process"});
		const train=await app.request("/v1/training-runs",{method:"POST",headers,body:JSON.stringify({idempotencyKey:"train-1",input:{config:{adapter:"qlora"}}})});
		expect(train.status).toBe(202);expect(await train.json()).toMatchObject({type:"training.qlora"});
	});
});
