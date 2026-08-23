#!/usr/bin/env node
import { serve } from "@hono/node-server";
import type { InferenceCaptureV2 } from "./contracts.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { Hono } from "hono";
import { atomic, digest, readJson, required, sanitize, stateRoot } from "./shared.js";

type ProxyOptions = {
	inferenceUrl?: string;
	inferenceControlUrl?: string;
	hermesUrl?: string;
	fetch?: typeof fetch;
	record?: (kind: "inference" | "agent-request", value: unknown) => void;
};

function source(request: Request) {
	const authorization = request.headers.get("authorization") ?? "";
	if (authorization === "Bearer lab-open-webui") return "open-webui" as const;
	if (authorization === "Bearer lab-hermes") return "hermes" as const;
	return request.headers.get("x-ai-client") === "open-webui" ? "open-webui" as const : "hermes" as const;
}
function parse(raw: string) { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } }
function safeResponse(raw: string) {
	if (!raw.startsWith("data:") && !raw.includes("\ndata:")) return sanitize(parse(raw));
	let content = ""; const toolCalls: unknown[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
		const event = parse(line.slice(5).trim()), choice = Array.isArray(event.choices) ? event.choices[0] as { delta?: { content?: unknown; tool_calls?: unknown[] } } : undefined;
		if (typeof choice?.delta?.content === "string") content += choice.delta.content;
		if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls);
		if (typeof event.delta === "string" && String(event.type ?? "").includes("output_text")) content += event.delta;
	}
	return sanitize({ streamed: true, streamDigest: digest(raw), message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) } });
}
function conversationId(request: Record<string, unknown>) {
	const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata as Record<string, unknown> : {};
	const value = request.chat_id ?? request.conversation_id ?? metadata.chat_id ?? metadata.conversation_id;
	return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/u.test(value) ? value : undefined;
}

export function createExperienceProxy(options: ProxyOptions = {}) {
	const app = new Hono(), requestFetch = options.fetch ?? fetch;
	const inference = options.inferenceUrl ?? process.env.INFERENCE_URL ?? "http://inference-api:4771";
	const inferenceControl = options.inferenceControlUrl ?? process.env.INFERENCE_CONTROL_URL ?? "http://inference-api:4770";
	const hermes = options.hermesUrl ?? process.env.HERMES_URL ?? "http://hermes-agent:8642";
	const persist = options.record ?? ((kind, value) => appendFileSync(`${stateRoot}/${kind === "inference" ? "inference-captures-v2" : "agent-requests"}.jsonl`, `${JSON.stringify(value)}\n`, { mode: 0o600 }));
	async function deployment(headers: Headers) {
		const fromHeaders = headers.get("x-ai-deployment-revision"), adapter = headers.get("x-ai-adapter-id");
		if (fromHeaders) return { deploymentRevision: fromHeaders, ...(adapter ? { adapterId: adapter } : {}) };
		try {
			const response = await requestFetch(`${inferenceControl}/v1/deployments/current`, { headers: { authorization: `Bearer ${required("AI_FACTORY_INFERENCE_KEY")}` } }), value = await response.json() as { deployment?: { id?: string; candidateId?: string } };
			if (response.ok && value.deployment) return { deploymentRevision: value.deployment.id ?? "active", ...(value.deployment.candidateId ? { adapterId: value.deployment.candidateId } : {}) };
		} catch {}
		return { deploymentRevision: `base:${process.env.BASE_MODEL_REVISION ?? "unknown"}` };
	}
	if (!options.record) mkdirSync(stateRoot, { recursive: true });
	app.get("/healthz", (context) => context.json({ ok: true }));
	app.get("/v1/models", async (context) => {
		const headers = new Headers(context.req.raw.headers);
		headers.set("authorization", `Bearer ${required("AI_FACTORY_INFERENCE_KEY")}`); headers.delete("host");
		let response: Response;
		try { response = await requestFetch(`${inference}/v1/models`, { headers, signal: context.req.raw.signal }); }
		catch { return context.json({ error: { code: "inference_unavailable", message: "Inference is unavailable." } }, 503); }
		if (!response.ok) return new Response(response.body, { status: response.status, headers: response.headers });
		const value = await response.json() as { data?: unknown[] }, data = Array.isArray(value.data) ? [...value.data] : [];
		if (!data.some((item) => (item as { id?: string }).id === "hermes-agent")) data.push({ id: "hermes-agent", object: "model", owned_by: "treeseed-ai-lab" });
		return context.json({ ...value, object: "list", data });
	});
	app.all("/v1/*", async (context) => {
		const body = ["GET", "HEAD"].includes(context.req.method) ? undefined : await context.req.raw.clone().text();
		const request = parse(body ?? ""), requestedModel = String(request.model ?? "local-model");
		const agentRequest = requestedModel === "hermes-agent", turnId = crypto.randomUUID(), providerConversationId = conversationId(request), sessionMapPath = `${stateRoot}/hermes-session-map.json`;
		const headers = new Headers(context.req.raw.headers);
		headers.set("authorization", `Bearer ${agentRequest ? required("HERMES_API_KEY") : required("AI_FACTORY_INFERENCE_KEY")}`);
		headers.set("x-treeai-turn-id", turnId); headers.delete("host");
		if (agentRequest && providerConversationId) {
			const existing = readJson<Record<string, string>>(sessionMapPath, {})[providerConversationId];
			if (existing) headers.set("x-hermes-session-id", existing);
		}
		let response: Response;
		try { response = await requestFetch(`${agentRequest ? hermes : inference}${context.req.path}${new URL(context.req.url).search}`, { method: context.req.method, headers, body, signal: context.req.raw.signal }); }
		catch { return context.json({ error: { code: agentRequest ? "agent_unavailable" : "inference_unavailable", message: agentRequest ? "Hermes Agent is unavailable." : "Inference is unavailable." } }, 503); }
		if (agentRequest && (response.status >= 500 || response.status === 401 || response.status === 403))
			return context.json({ error: { code: "agent_unavailable", message: "Hermes Agent is unavailable." } }, 503);
		const responseHeaders = new Headers(response.headers); responseHeaders.set("x-treeai-turn-id", turnId);
		const sessionId = responseHeaders.get("x-hermes-session-id") ?? undefined;
		if (agentRequest) {
			if (providerConversationId && sessionId) atomic(sessionMapPath, { ...readJson<Record<string, string>>(sessionMapPath, {}), [providerConversationId]: sessionId });
			persist("agent-request", { schemaVersion: "ai.agent-request/v1", id: crypto.randomUUID(), turnId, hermesSessionId: sessionId, providerConversationId, sourceClient: source(context.req.raw), capturedAt: new Date().toISOString(), requestDigest: digest(body ?? ""), requestedModel });
		} else if (context.req.header("x-ai-experience") !== "ignore" && /\/(chat\/completions|responses)$/u.test(context.req.path)) {
			const clone = response.clone();
			void clone.text().then(async (raw) => {
				const active = await deployment(responseHeaders);
				const hermesSessionId = context.req.header("x-treeai-hermes-session-id"), hermesTurnId = context.req.header("x-treeai-hermes-turn-id");
				const capture: InferenceCaptureV2 = { schemaVersion: "ai.inference-capture/v2", id: crypto.randomUUID(), turnId, sourceClient: source(context.req.raw), capturedAt: new Date().toISOString(), requestDigest: digest(body ?? ""), request: sanitize(request) as Record<string, unknown>, response: safeResponse(raw), status: response.status, requestedModel, ...(hermesSessionId ? { hermesSessionId } : {}), ...(hermesTurnId ? { hermesTurnId } : {}), resolvedDeployment: { baseModelRevision: process.env.BASE_MODEL_REVISION ?? "unknown", ...active } };
				persist("inference", capture);
			}).catch(() => {});
		}
		return new Response(response.body, { status: response.status, headers: responseHeaders });
	});
	return app;
}

if (process.env.NODE_ENV !== "test") serve({ fetch: createExperienceProxy().fetch, hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
