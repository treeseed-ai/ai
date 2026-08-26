import { describe, expect, it } from "vitest";
import { actionSequences, ktoLabel, normalizeEvents, observeArtifacts, sanitizeEvidence } from "../../packages/lab/src/evidence.js";
import { createExperienceProxy } from "../../packages/lab/src/proxy.js";
import { AgentProfiles, profileMarker } from "../../packages/lab/src/agents/index.js";
import { discoverProviderModels, hasSuccessfulWebEvidence } from "../../packages/lab/src/controller.js";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("tight Hermes integration", () => {
	it("merges discovery and routes only the fixed Hermes model", async () => {
		process.env.AI_FACTORY_INFERENCE_KEY = "inference-secret";
		process.env.HERMES_API_KEY = "hermes-secret";
		const calls: Array<{ url: string; authorization: string }> = [], records: Array<{ kind: string; value: unknown }> = [];
		const request = async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input), authorization = new Headers(init?.headers).get("authorization") ?? "";
			calls.push({ url, authorization });
			if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: [{ id: "local-model" }] });
			return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] }, { headers: url.includes("hermes-agent") ? { "x-hermes-session-id": "session-1" } : {} });
		};
		const app = createExperienceProxy({ inferenceUrl: "http://inference", hermesUrl: "http://hermes-agent:8642", fetch: request as typeof fetch, record: (kind, value) => records.push({ kind, value }) });
		const models = await (await app.request("/v1/models", { headers: { authorization: "Bearer lab-open-webui" } })).json() as { data: Array<{ id: string }> };
		expect(models.data.map(({ id }) => id)).toEqual(["local-model", "hermes-agent", "agent/auto"]);
		await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer lab-open-webui", "content-type": "application/json" }, body: JSON.stringify({ model: "hermes-agent", messages: [{ role: "user", content: "test" }] }) });
		expect(calls.at(-1)).toEqual({ url: "http://hermes-agent:8642/v1/chat/completions", authorization: "Bearer hermes-secret" });
		expect(records).toHaveLength(1);
		expect(records[0]?.kind).toBe("agent-request");
	});

	it("normalizes action boundaries without hidden reasoning and maps KTO signs", () => {
		const events = normalizeEvents([
			{ role: "user", content: "task" },
			{ role: "assistant", content: "<think>private reasoning</think>run", reasoning: "hidden" },
			{ role: "tool", content: "done", tool_name: "terminal" },
			{ role: "user", content: "thanks" },
		]);
		expect(JSON.stringify(events)).not.toContain("hidden");
		expect(JSON.stringify(events)).not.toContain("private reasoning");
		expect(actionSequences("trajectory", events)).toHaveLength(1);
		const base = { actionSequenceId: "sequence", confidence: 0.8, rationale: "successful", evaluator: { model: "local-model", revision: "r1", harness: "hermes" } };
		expect(ktoLabel({ ...base, score: 0.25 })?.label).toBe("desirable");
		expect(ktoLabel({ ...base, score: -0.25 })?.label).toBe("undesirable");
		expect(ktoLabel({ ...base, score: 0 })).toBeUndefined();
	});

	it("routes adapter agents through Hermes and rewrites only validated inner markers", async () => {
		process.env.AI_FACTORY_INFERENCE_KEY = "inference-secret"; process.env.HERMES_API_KEY = "hermes-secret";
		const root=mkdtempSync(join(tmpdir(),"treeai-agent-proxy-")),profiles=new AgentProfiles(root),profile=profiles.promote("library-1","finance","candidate-1",["evaluation-1"]),calls:Array<{url:string;body:Record<string,unknown>}>=[];
		const request=async(input:string|URL|Request,init?:RequestInit)=>{const body=JSON.parse(String(init?.body??"{}"))as Record<string,unknown>;calls.push({url:String(input),body});if(String(input).endsWith("/v1/models"))return Response.json({object:"list",data:[{id:"local-model"}]});if(String(input).includes("library-deployments"))return Response.json({items:[{modelAlias:"library/finance",candidateId:"candidate-1"}]});return Response.json({choices:[{message:{role:"assistant",content:"ok"}}]},{headers:{"x-hermes-session-id":"session-1"}});};
		const app=createExperienceProxy({inferenceUrl:"http://inference",inferenceControlUrl:"http://control",hermesUrl:"http://hermes",fetch:request as typeof fetch,record:()=>{},profiles});
		const models=await(await app.request("/v1/models")).json()as{data:Array<{id:string}>};expect(models.data.map(item=>item.id)).toContain("agent/finance");
		await app.request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"agent/finance",conversation_id:"chat-1",messages:[{role:"user",content:"analyze"}]})});expect(calls.at(-1)?.url).toBe("http://hermes/v1/chat/completions");expect(JSON.stringify(calls.at(-1)?.body)).toContain("TREEAI_AGENT_PROFILE");
		const segment=crypto.randomUUID();await app.request("/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json","x-treeai-hermes-session-id":"session-1"},body:JSON.stringify({model:"local-model",messages:[{role:"system",content:`${profileMarker(profile,segment)}\nUse evidence.`}]})});expect(calls.at(-1)?.url).toBe("http://inference/v1/chat/completions");expect(calls.at(-1)?.body.model).toBe("library/finance");expect(JSON.stringify(calls.at(-1)?.body)).not.toContain("TREEAI_AGENT_PROFILE");
	});

	it("normalizes Hermes timestamps and workspace paths for durable evidence", () => {
		const events = normalizeEvents([{ role: "user", content: "[CONTEXT COMPACTION — REFERENCE ONLY] internal" }, { id: 7, role: "tool", timestamp: 1_787_491_030.5, content: { resolved_path: "/workspace/result.md" }, tool_calls: [{ function: { arguments: '{"path":"/workspace/result.md"}' } }] }]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: "7", timestamp: "2026-08-23T13:17:10.500Z", content: { resolved_path: "result.md" } });
		expect(JSON.stringify(events)).not.toContain("/workspace/");
		expect(sanitizeEvidence("opened /etc/shadow")).toBe("opened [REDACTED_PATH]");
	});

	it("skips unreadable legacy artifacts while harvesting new readable files", () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-evidence-")), workspace = join(root, "workspace"), state = join(root, "state");
		mkdirSync(workspace); mkdirSync(state);
		const legacy = join(workspace, "legacy.txt");
		writeFileSync(legacy, "historical"); chmodSync(legacy, 0o000);
		writeFileSync(join(workspace, "current.txt"), "current");
		const observations = observeArtifacts("trajectory", { workspace, state });
		expect(observations.map(({ relativePath }) => relativePath)).toEqual(["current.txt"]);
		const event = readFileSync(join(state, "events.jsonl"), "utf8");
		expect(event).toContain('"type":"artifact.unavailable"');
		expect(event).toContain('"relativePath":"legacy.txt"');
		expect(event).not.toContain(root);
		chmodSync(legacy, 0o600);
	});

	it("preserves authoritative Hermes session correlation on inner inference", async () => {
		process.env.AI_FACTORY_INFERENCE_KEY = "inference-secret";
		const records: Array<{ kind: string; value: Record<string, unknown> }> = [];
		const request = async (input: string | URL | Request) => String(input).includes("deployments/current")
			? Response.json({ deployment: { id: "deployment-7", candidateId: "adapter-3" } })
			: Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
		const app = createExperienceProxy({ inferenceUrl: "http://inference", inferenceControlUrl: "http://control", fetch: request as typeof fetch, record: (kind, value) => records.push({ kind, value: value as Record<string, unknown> }) });
		await app.request("/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer lab-hermes", "content-type": "application/json", "x-treeai-hermes-session-id": "session-authoritative", "x-treeai-hermes-turn-id": "turn-authoritative" }, body: JSON.stringify({ model: "local-model", messages: [{ role: "user", content: "test" }] }) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(records[0]?.value).toMatchObject({ schemaVersion: "ai.inference-capture/v2", hermesSessionId: "session-authoritative", hermesTurnId: "turn-authoritative", resolvedDeployment: { deploymentRevision: "deployment-7", adapterId: "adapter-3" } });
	});

	it("returns a typed unavailable response when the private Hermes API fails", async () => {
		process.env.AI_FACTORY_INFERENCE_KEY = "inference-secret";
		process.env.HERMES_API_KEY = "hermes-secret";
		const app = createExperienceProxy({ fetch: (async () => new Response("internal details", { status: 500 })) as typeof fetch, record: () => {} });
		const response = await app.request("/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "hermes-agent", messages: [] }) });
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: { code: "agent_unavailable", message: "Hermes Agent is unavailable." } });
	});

	it("verifies merged provider models through the authenticated controller", async () => {
		const request = (async (input: string | URL | Request) => String(input).endsWith("/v1/models")
			? Response.json({ object: "list", data: [{ id: "local-model" }, { id: "hermes-agent" }] })
			: Response.json({ status: "ok" })) as typeof fetch;
		expect(await discoverProviderModels(request, "http://experience-proxy:8080")).toMatchObject({ data: [{ id: "local-model" }, { id: "hermes-agent" }] });
		const controller = readFileSync("packages/lab/src/controller.ts", "utf8");
		expect(controller).toContain('{ method: "GET", path: "/v1/provider/models"');
		expect(controller).toContain('app.get("/v1/provider/models", requireScope("lab:read")');
		expect(controller).toContain('multimodalDirect: multimodal || undefined');
		expect(controller).toContain('await completion("hermes-agent", false, content)');
		const cli = readFileSync("packages/lab/src/cli.ts", "utf8");
		expect(cli).toContain('call("/v1/hermes/verify", "POST", { multimodal })');
		expect(cli).toContain('"--multimodal"')
	});

	it("rejects error-bearing extraction output as web evidence", () => {
		const search = { role: "tool", toolName: "web_search", content: '{"data":{"web":[{"provenance":{}}]}}' };
		expect(hasSuccessfulWebEvidence([search, { role: "tool", toolName: "web_extract", content: '{"results":[{"error":"blocked"}]}' }])).toBe(false);
		expect(hasSuccessfulWebEvidence([search, { role: "tool", toolName: "web_extract", content: '<untrusted>{"results":[{"error":null,"provenance":{"status":200,"sha256":"abc"}}]}</untrusted>' }])).toBe(true);
		expect(hasSuccessfulWebEvidence([search, { role: "tool", toolName: "web_extract", content: '{"success":false,"error":null,"provenance":{}}' }])).toBe(false);
	});
});
