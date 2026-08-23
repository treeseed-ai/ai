import { describe, expect, it } from "vitest";
import { actionSequences, ktoLabel, normalizeEvents } from "../../packages/lab/src/evidence.js";
import { createExperienceProxy } from "../../packages/lab/src/proxy.js";

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
		expect(models.data.map(({ id }) => id)).toEqual(["local-model", "hermes-agent"]);
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
});
