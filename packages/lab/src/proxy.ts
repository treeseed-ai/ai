#!/usr/bin/env node
import { serve } from "@hono/node-server";
import type { InferenceCaptureV2 } from "./contracts.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { Hono } from "hono";
import { atomic, digest, readJson, required, sanitize, stateRoot } from "./shared.js";
import { AgentProfiles, extractProfileMarker, profileMarker } from "./agents/index.js";
import { compactContext } from "./agents/context.js";

type ProxyOptions = {
	inferenceUrl?: string;
	inferenceControlUrl?: string;
	hermesUrl?: string;
	fetch?: typeof fetch;
	record?: (kind: "inference" | "agent-request", value: unknown) => void;
	profiles?: AgentProfiles;
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
	const agentProfiles = options.profiles ?? new AgentProfiles();
	const persist = options.record ?? ((kind, value) => appendFileSync(`${stateRoot}/${kind === "inference" ? "inference-captures-v2" : "agent-requests"}.jsonl`, `${JSON.stringify(value)}\n`, { mode: 0o600 }));
	async function deployment(headers: Headers, modelAlias = "local-model") {
		const fromHeaders = headers.get("x-ai-deployment-revision"), adapter = headers.get("x-ai-adapter-id");
		if (fromHeaders) return { deploymentRevision: fromHeaders, ...(adapter ? { adapterId: adapter } : {}) };
		try {
			const target = modelAlias.startsWith("library/") ? "/v1/library-deployments" : "/v1/deployments/current", response = await requestFetch(`${inferenceControl}${target}`, { headers: { authorization: `Bearer ${required("AI_FACTORY_INFERENCE_KEY")}` } }), value = await response.json() as { deployment?: { id?: string; candidateId?: string }; items?: Array<{ modelAlias?: string; candidateId?: string }> };
			if (modelAlias.startsWith("library/")) { const item = value.items?.find((entry) => entry.modelAlias === modelAlias); if (response.ok && item) return { deploymentRevision: modelAlias, ...(item.candidateId ? { adapterId: item.candidateId } : {}) }; }
			if (response.ok && value.deployment) return { deploymentRevision: value.deployment.id ?? "active", ...(value.deployment.candidateId ? { adapterId: value.deployment.candidateId } : {}) };
		} catch {}
		return { deploymentRevision: `base:${process.env.BASE_MODEL_REVISION ?? "unknown"}` };
	}
	if (!options.record) mkdirSync(stateRoot, { recursive: true });
	app.get("/healthz", (context) => context.json({ ok: true }));
	app.post("/internal/v1/handoff", async (context) => { if (context.req.header("authorization") !== `Bearer ${required("HERMES_API_KEY")}`) return context.json({ error: { code: "not_found", message: "Route not found." } }, 404); const body = await context.req.json().catch(() => ({})) as { conversationId?: string; profileId?: string; state?: Record<string, unknown> }; if (!body.conversationId || !body.profileId || !body.state) return context.json({ error: { code: "invalid_request", message: "conversationId, profileId, and structured state are required." } }, 400); try { return context.json(agentProfiles.handoff(body.conversationId, body.profileId, sanitize(body.state) as Record<string, unknown>)); } catch (error) { return context.json({ error: { code: "handoff_rejected", message: error instanceof Error ? error.message : String(error) } }, 409); } });
	app.get("/v1/models", async (context) => {
		const headers = new Headers(context.req.raw.headers);
		headers.set("authorization", `Bearer ${required("AI_FACTORY_INFERENCE_KEY")}`); headers.delete("host");
		let response: Response;
		try { response = await requestFetch(`${inference}/v1/models`, { headers, signal: context.req.raw.signal }); }
		catch { return context.json({ error: { code: "inference_unavailable", message: "Inference is unavailable." } }, 503); }
		if (!response.ok) return new Response(response.body, { status: response.status, headers: response.headers });
		const value = await response.json() as { data?: unknown[] }, data = Array.isArray(value.data) ? [...value.data] : [];
		if (!data.some((item) => (item as { id?: string }).id === "hermes-agent")) data.push({ id: "hermes-agent", object: "model", owned_by: "treeseed-ai-lab" });
		data.push({ id: "agent/auto", object: "model", owned_by: "treeseed-ai-lab" }, ...agentProfiles.list().filter((item) => item.status === "enabled").map((item) => ({ id: `agent/${item.slug}`, object: "model", owned_by: "treeseed-ai-lab", name: item.displayName, description: item.description })));
		return context.json({ ...value, object: "list", data });
	});
	app.all("/v1/*", async (context) => {
		let body = ["GET", "HEAD"].includes(context.req.method) ? undefined : await context.req.raw.clone().text();
		let request = parse(body ?? ""), requestedModel = String(request.model ?? "local-model");
		const agentRequest = requestedModel === "hermes-agent" || requestedModel === "agent/auto" || requestedModel.startsWith("agent/"), turnId = crypto.randomUUID(), providerConversationId = conversationId(request), sessionMapPath = `${stateRoot}/hermes-session-map.json`;
		let selected: ReturnType<AgentProfiles["select"]> = null;
		if (agentRequest && requestedModel !== "hermes-agent") { try { selected = agentProfiles.select(requestedModel, Array.isArray(request.messages) ? request.messages : [], providerConversationId); } catch (error) { return context.json({ error: { code: "agent_unavailable", message: error instanceof Error ? error.message : String(error) } }, 503); } if (selected) { const compacted=await compactContext(Array.isArray(request.messages)?request.messages:[],selected.profile,async(model,prompt)=>{const response=await requestFetch(`${inference}/v1/chat/completions`,{method:"POST",headers:{authorization:`Bearer ${required("AI_FACTORY_INFERENCE_KEY")}`,"content-type":"application/json","x-ai-experience":"ignore"},body:JSON.stringify({model,messages:[{role:"user",content:prompt}],temperature:0,max_tokens:1024}),signal:context.req.raw.signal});if(!response.ok)throw new Error("Context compaction failed");const value=await response.json()as{choices?:Array<{message?:{content?:string}}>} ;return value.choices?.[0]?.message?.content??"";}); const system = `${profileMarker(selected.profile, selected.decision.segmentId)}\n${selected.profile.systemInstructions}`; request = { ...request, model: "hermes-agent", messages: [{ role: "system", content: system }, ...compacted] }; body = JSON.stringify(request); } }
		let routedModel = requestedModel;
		if (!agentRequest && Array.isArray(request.messages)) { const marker = extractProfileMarker(request.messages); if (marker) { const profile = agentProfiles.get(marker.profileId); if (!profile || profile.status !== "enabled" || profile.modelAlias !== marker.modelAlias) return context.json({ error: { code: "agent_profile_invalid", message: "Agent profile routing marker is invalid." } }, 409); routedModel = profile.modelAlias; request = { ...request, model: routedModel, messages: request.messages.map((message) => message && typeof message === "object" && typeof (message as { content?: unknown }).content === "string" && String((message as { content?: unknown }).content).includes("[TREEAI_AGENT_PROFILE:") ? { ...message, content: String((message as { content?: unknown }).content).replace(/\[TREEAI_AGENT_PROFILE:[^\]]+\]\s*/u, "") } : message) }; body = JSON.stringify(request); } }
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
			persist("agent-request", { schemaVersion: "ai.agent-request/v1", id: crypto.randomUUID(), turnId, hermesSessionId: sessionId, providerConversationId, sourceClient: source(context.req.raw), capturedAt: new Date().toISOString(), requestDigest: digest(body ?? ""), requestedModel, ...(selected ? { agentProfileId: selected.profile.id, segmentId: selected.decision.segmentId, resolvedModelAlias: selected.profile.modelAlias } : {}) });
		} else if (context.req.header("x-ai-experience") !== "ignore" && /\/(chat\/completions|responses)$/u.test(context.req.path)) {
			const clone = response.clone();
			void clone.text().then(async (raw) => {
				const active = await deployment(responseHeaders, routedModel);
				const hermesSessionId = context.req.header("x-treeai-hermes-session-id"), hermesTurnId = context.req.header("x-treeai-hermes-turn-id");
				const capture: InferenceCaptureV2 = { schemaVersion: "ai.inference-capture/v2", id: crypto.randomUUID(), turnId, sourceClient: source(context.req.raw), capturedAt: new Date().toISOString(), requestDigest: digest(body ?? ""), request: sanitize(request) as Record<string, unknown>, response: safeResponse(raw), status: response.status, requestedModel: routedModel, ...(hermesSessionId ? { hermesSessionId } : {}), ...(hermesTurnId ? { hermesTurnId } : {}), resolvedDeployment: { baseModelRevision: process.env.BASE_MODEL_REVISION ?? "unknown", ...active } };
				persist("inference", capture);
			}).catch(() => {});
		}
		return new Response(response.body, { status: response.status, headers: responseHeaders });
	});
	return app;
}

if (process.env.NODE_ENV !== "test") serve({ fetch: createExperienceProxy().fetch, hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
