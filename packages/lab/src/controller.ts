#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { apiKeyAuthorization, openApiDocument, parseBootstrapKeys, requireScope, type RouteSpec } from "@ai-platform/common";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { appendEvent, atomic, lines, readJson, required, sanitize, stateRoot } from "./shared.js";
import { finalizeEvidence, sourceForSession } from "./evidence.js";

type ControllerOptions = { fetch?: typeof fetch; now?: () => number };
const sessionPattern = /^[A-Za-z0-9._-]{1,128}$/u;

export async function discoverProviderModels(requestFetch: typeof fetch, experienceUrl: string) {
	const response = await requestFetch(`${experienceUrl}/v1/models`, { headers: { authorization: "Bearer lab-open-webui" } });
	const value = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`Experience provider models returned ${response.status}`);
	return sanitize(value);
}

export function hasSuccessfulWebEvidence(events: Array<{ role?: string; toolName?: string; content?: unknown }>) {
	function payload(content: unknown) {
		const text = String(content ?? ""), start = text.indexOf("{"), end = text.lastIndexOf("}");
		if (start < 0 || end <= start) return null;
		try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return null; }
	}
	function hasError(value: unknown): boolean {
		if (Array.isArray(value)) return value.some(hasError);
		if (!value || typeof value !== "object") return false;
		return Object.entries(value).some(([key, item]) => (key === "error" && item !== null && item !== "") || (key === "success" && item === false) || hasError(item));
	}
	const successful = events.filter((event) => event.role === "tool" && ["web_search", "web_extract"].includes(event.toolName ?? "") && payload(event.content) && !hasError(payload(event.content)));
	const search = successful.some((event) => event.toolName === "web_search" && String(event.content).includes('"provenance"'));
	const extract = successful.some((event) => event.toolName === "web_extract" && String(event.content).includes('"provenance"'));
	return search && extract;
}

function migrateCaptureV1() {
	const receipt = `${stateRoot}/capture-v1-migration.json`;
	if (existsSync(receipt)) return;
	const names = ["captures.jsonl", "qualified.jsonl", "cycles.jsonl", "loop.json", "idempotency.json"], present = names.filter((name) => existsSync(`${stateRoot}/${name}`));
	if (!present.length) return atomic(receipt, { schemaVersion: "ai.capture-migration/v1", status: "not-required", completedAt: new Date().toISOString(), archived: [] });
	const stamp = new Date().toISOString().replace(/[:.]/gu, "-"), archive = `${stateRoot}/archive/capture-v1-${stamp}`;
	mkdirSync(archive, { recursive: true, mode: 0o700 });
	for (const name of present) renameSync(`${stateRoot}/${name}`, `${archive}/${name}`);
	atomic(receipt, { schemaVersion: "ai.capture-migration/v1", status: "archived", completedAt: new Date().toISOString(), archive: `archive/capture-v1-${stamp}`, archived: present });
}

function extractItems(value: unknown, key = "data") {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Array.isArray(record[key])) return record[key] as unknown[];
		if (Array.isArray(record.messages)) return record.messages as unknown[];
	}
	return [];
}

export function createLabController(options: ControllerOptions = {}) {
	migrateCaptureV1();
	const requestFetch = options.fetch ?? fetch, now = options.now ?? Date.now;
	const hermesUrl = process.env.HERMES_URL ?? "http://hermes-agent:8642";
	const experienceUrl = process.env.EXPERIENCE_PROXY_URL ?? "http://experience-proxy:8080";
	const webToolUrl = process.env.WEB_TOOL_URL ?? "http://web-tool-proxy:8090";
	const keys = parseBootstrapKeys(process.env.AI_LAB_API_KEYS ?? "");
	async function hermes(path: string, method = "GET") {
		const response = await requestFetch(`${hermesUrl}${path}`, { method, headers: { authorization: `Bearer ${required("HERMES_API_KEY")}`, "content-type": "application/json" } });
		const value = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(`Hermes ${path} returned ${response.status}`);
		return sanitize(value);
	}
	async function providerModels() {
		return discoverProviderModels(requestFetch, experienceUrl);
	}
	async function webTool(path: "/search" | "/extract", body: Record<string, unknown>) {
		const response = await requestFetch(`${webToolUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const value = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (!response.ok) throw new Error(`Safe web tool ${path} returned ${response.status}`);
		return value;
	}
	async function finalize(id: string) {
		if (!sessionPattern.test(id)) throw new Error("Invalid Hermes session identifier");
		const sessionValue = await hermes(`/api/sessions/${encodeURIComponent(id)}`) as Record<string, unknown>;
		const session = (sessionValue.session ?? sessionValue) as Record<string, unknown>;
		const messageValue = await hermes(`/api/sessions/${encodeURIComponent(id)}/messages`);
		const trajectory = finalizeEvidence(session, extractItems(messageValue) as never[], sourceForSession(id, String(session.source ?? "")));
		appendEvent("trajectory.finalized", { id: trajectory.id, hermesSessionId: id });
		return trajectory;
	}
	async function deepVerify() {
		const artifactName = `treeai-hermes-deep-check-${crypto.randomUUID()}.txt`, artifactContent = `TREEAI_HERMES_READY_${crypto.randomUUID()}`,
			webArtifactName = `treeai-hermes-web-check-${crypto.randomUUID()}.md`;
		async function completion(model: string, stream: boolean, content: string) {
			const response = await requestFetch(`${experienceUrl}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer lab-hermes", "content-type": "application/json", "x-ai-client": "hermes" }, body: JSON.stringify({ model, stream, messages: [{ role: "user", content }], temperature: 0 }) });
			const raw = await response.text();
			if (!response.ok || !raw) throw new Error(`${model} ${stream ? "streaming" : "non-streaming"} verification failed`);
			return { sessionId: response.headers.get("x-hermes-session-id") };
		}
		await completion("local-model", false, "Reply with DIRECT_READY only.");
		await completion("local-model", true, "Reply with STREAM_READY only.");
		const search = await webTool("/search", { query: "IANA example domains", limit: 3 }), searchResults = extractItems(search, "results") as Array<Record<string, unknown>>;
		if (!searchResults.length || !searchResults.some((item) => (item.provenance as Record<string, unknown> | undefined)?.sha256)) throw new Error("Safe web search returned no provenance-bearing results");
		const extraction = await webTool("/extract", { urls: ["https://www.iana.org/help/example-domains"] }), extractionResults = extractItems(extraction, "results") as Array<Record<string, unknown>>;
		if (!extractionResults.some((item) => item.status === 200 && typeof item.sha256 === "string" && String(item.text ?? "").includes("Example Domains"))) throw new Error("Safe web extraction returned no verified IANA provenance");
		const agent = await completion("hermes-agent", false, `Use the file tool to create /workspace/${artifactName} containing exactly ${artifactContent}, read it back, then reply with HERMES_READY.`);
		await completion("hermes-agent", true, "Reply with HERMES_STREAM_READY only.");
		if (!agent.sessionId) throw new Error("Hermes verification did not return a session identifier");
		const trajectory = await finalize(agent.sessionId);
		const observations = lines(`${stateRoot}/artifact-observations.jsonl`), correlated = observations.find((item) => trajectory.artifactObservationIds.includes(String(item.id)) && item.relativePath === artifactName);
		if (!correlated) throw new Error("Hermes verification did not produce the expected correlated workspace artifact");
		const webAgent = await completion("hermes-agent", false, `Use web_search to search for IANA Example Domains, use web_extract on https://www.iana.org/help/example-domains, then create /workspace/${webArtifactName} with a concise sourced summary containing the words Example Domain. Reply WEB_READY.`);
		if (!webAgent.sessionId) throw new Error("Hermes web verification did not return a session identifier");
		const webTrajectory = await finalize(webAgent.sessionId), webObservations = lines(`${stateRoot}/artifact-observations.jsonl`), webCorrelated = webObservations.find((item) => webTrajectory.artifactObservationIds.includes(String(item.id)) && item.relativePath === webArtifactName);
		if (!webCorrelated) throw new Error("Hermes web verification did not produce the expected correlated workspace artifact");
		if (!hasSuccessfulWebEvidence(webTrajectory.events)) throw new Error("Hermes web verification did not retain successful search and extraction evidence");
		return { status: "ready", direct: true, streaming: true, hermes: true, web: true, trajectoryId: trajectory.id, webTrajectoryId: webTrajectory.id, artifacts: [...trajectory.artifactObservationIds, ...webTrajectory.artifactObservationIds] };
	}
	async function idempotent(context: Context, action: string, operation: () => Promise<unknown>) {
		const key = context.req.header("idempotency-key");
		if (!key || key.length > 200) return context.json({ error: { code: "invalid_request", message: "A valid Idempotency-Key is required." } }, 400);
		const path = `${stateRoot}/idempotency-v2.json`, receipts = readJson<Record<string, unknown>>(path, {}), receiptKey = `${action}:${key}`;
		if (receipts[receiptKey]) return context.json(receipts[receiptKey], 202);
		const result = await operation(); receipts[receiptKey] = result; atomic(path, receipts);
		return context.json(result, 202);
	}
	const routes: RouteSpec[] = [
		{ method: "GET", path: "/healthz", summary: "Liveness" }, { method: "GET", path: "/readyz", summary: "Readiness" },
		{ method: "GET", path: "/v1/status", summary: "Lab state", scope: "lab:read" },
		{ method: "GET", path: "/v1/provider/models", summary: "Sanitized provider model discovery", scope: "lab:read" },
		{ method: "GET", path: "/v1/hermes/status", summary: "Hermes status", scope: "lab:hermes:read" },
		{ method: "GET", path: "/v1/hermes/capabilities", summary: "Hermes capabilities", scope: "lab:hermes:read" },
		{ method: "GET", path: "/v1/hermes/tools", summary: "Hermes tools", scope: "lab:hermes:read" },
		{ method: "GET", path: "/v1/hermes/sessions", summary: "Hermes sessions", scope: "lab:hermes:read" },
		{ method: "GET", path: "/v1/hermes/sessions/:id", summary: "Hermes session", scope: "lab:hermes:read" },
		{ method: "POST", path: "/v1/hermes/sessions/:id/finalize", summary: "Finalize Hermes evidence", scope: "lab:experience:write" },
		{ method: "POST", path: "/v1/hermes/verify", summary: "Run bounded Hermes verification", scope: "lab:experience:write" },
		{ method: "GET", path: "/v1/trajectories", summary: "Agent trajectories", scope: "lab:read" },
		{ method: "GET", path: "/v1/trajectories/:id", summary: "Agent trajectory", scope: "lab:read" },
		{ method: "GET", path: "/v1/artifacts", summary: "Artifact observations", scope: "lab:read" },
		{ method: "GET", path: "/v1/cycles", summary: "Disabled training cycles", scope: "lab:read" },
		{ method: "GET", path: "/v1/experience", summary: "Captured trajectories", scope: "lab:read" },
		{ method: "GET", path: "/v1/events/stream", summary: "Events", scope: "lab:read" },
		{ method: "GET", path: "/v1/metrics", summary: "Metrics", scope: "metrics:read" },
		{ method: "POST", path: "/v1/loop/enable", summary: "Enable loop", scope: "lab:write" },
		{ method: "POST", path: "/v1/loop/cycle-now", summary: "Start cycle", scope: "lab:write" },
		{ method: "POST", path: "/v1/loop/pause", summary: "Pause loop", scope: "lab:write" },
		{ method: "POST", path: "/v1/loop/resume", summary: "Resume loop", scope: "lab:write" },
	];
	const app = new Hono();
	app.get("/healthz", (context) => context.json({ ok: true })); app.get("/readyz", async (context) => { try { await hermes("/health"); return context.json({ ok: true }); } catch { return context.json({ ok: false, reason: "hermes-unavailable" }, 503); } });
	app.get("/openapi.json", (context) => context.json(openApiDocument({ title: "AI Experience Lab API", version: "0.8.0", routes })));
	app.get("/docs", (context) => context.html('<!doctype html><title>TreeAI Lab API</title><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>'));
	app.onError((error, context) => context.json({ error: { code: "agent_unavailable", message: "Hermes Agent is unavailable." } }, 503));
	app.use("/v1/*", apiKeyAuthorization(async (id) => keys.find((key) => key.id === id) ?? null));
	app.get("/v1/status", requireScope("lab:read"), (context) => context.json({ enabled: false, paused: true, phase: "training-pipelines-not-configured", trajectories: lines(`${stateRoot}/trajectories.jsonl`).length }));
	app.get("/v1/provider/models", requireScope("lab:read"), async (context) => context.json(await providerModels()));
	app.get("/v1/hermes/status", requireScope("lab:hermes:read"), async (context) => context.json(await hermes("/health/detailed")));
	app.get("/v1/hermes/capabilities", requireScope("lab:hermes:read"), async (context) => context.json(await hermes("/v1/capabilities")));
	app.get("/v1/hermes/tools", requireScope("lab:hermes:read"), async (context) => context.json(await hermes("/v1/toolsets")));
	app.get("/v1/hermes/sessions", requireScope("lab:hermes:read"), async (context) => context.json(await hermes("/api/sessions")));
	app.get("/v1/hermes/sessions/:id", requireScope("lab:hermes:read"), async (context) => sessionPattern.test(context.req.param("id")) ? context.json(await hermes(`/api/sessions/${encodeURIComponent(context.req.param("id"))}`)) : context.json({ error: { code: "invalid_request", message: "Invalid session ID" } }, 400));
	app.post("/v1/hermes/sessions/:id/finalize", requireScope("lab:experience:write"), async (context) => {
		try { return await idempotent(context, `finalize:${context.req.param("id")}`, () => finalize(context.req.param("id"))); } catch { return context.json({ error: { code: "finalization_failed", message: "Hermes evidence could not be finalized." } }, 422); }
	});
	app.post("/v1/hermes/verify", requireScope("lab:experience:write"), async (context) => {
		try { return await idempotent(context, "hermes-verify", deepVerify); }
		catch (error) {
			appendEvent("hermes.deep-verification-failed", { message: sanitize(error instanceof Error ? error.message : String(error)) });
			return context.json({ error: { code: "deep_verification_failed", message: "Hermes completed an unhealthy deep verification step." } }, 422);
		}
	});
	app.get("/v1/trajectories", requireScope("lab:read"), (context) => context.json({ items: lines(`${stateRoot}/trajectories.jsonl`).reverse() }));
	app.get("/v1/trajectories/:id", requireScope("lab:read"), (context) => { const item = lines(`${stateRoot}/trajectories.jsonl`).find((value) => value.id === context.req.param("id")); return item ? context.json(item) : context.json({ error: { code: "not_found", message: "Trajectory not found" } }, 404); });
	app.get("/v1/artifacts", requireScope("lab:read"), (context) => context.json({ items: lines(`${stateRoot}/artifact-observations.jsonl`).reverse() }));
	app.get("/v1/cycles", requireScope("lab:read"), (context) => context.json({ items: [], disabled: true }));
	app.get("/v1/experience", requireScope("lab:read"), (context) => context.json({ items: lines(`${stateRoot}/trajectories.jsonl`).reverse() }));
	for (const action of ["enable", "cycle-now", "resume"]) app.post(`/v1/loop/${action}`, requireScope("lab:write"), (context) => context.req.header("idempotency-key") ? context.json({ error: { code: "training_pipeline_not_configured", message: "Continual pretraining, corrective SFT, and KTO pipelines must be qualified before automatic cycling can be enabled." } }, 409) : context.json({ error: { code: "invalid_request", message: "Idempotency-Key is required." } }, 400));
	app.post("/v1/loop/pause", requireScope("lab:write"), (context) => context.req.header("idempotency-key") ? context.json({ enabled: false, paused: true, phase: "training-pipelines-not-configured" }) : context.json({ error: { code: "invalid_request", message: "Idempotency-Key is required." } }, 400));
	app.get("/v1/metrics", requireScope("metrics:read"), (context) => context.text(`ai_lab_trajectories ${lines(`${stateRoot}/trajectories.jsonl`).length}\nai_lab_artifact_observations ${lines(`${stateRoot}/artifact-observations.jsonl`).length}\nai_lab_loop_enabled 0\n`, 200, { "content-type": "text/plain; version=0.0.4" }));
	app.get("/v1/events/stream", requireScope("lab:read"), (context) => streamSSE(context, async (stream) => { let cursor = context.req.header("last-event-id") ?? ""; while (!stream.closed) { for (const event of lines(`${stateRoot}/events.jsonl`)) { if (event.id <= cursor) continue; await stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event.data) }); cursor = event.id; } await stream.writeSSE({ event: "heartbeat", data: "{}" }); await stream.sleep(2000); } }));
	const synchronize = async () => { try { const value = await hermes("/api/sessions?limit=100"), cutoff = now() - 600_000; for (const item of extractItems(value) as Array<Record<string, unknown>>) { const id = String(item.id ?? item.session_id ?? ""), raw = item.last_active ?? item.updated_at ?? item.created_at, numeric = Number(raw), last = Number.isFinite(numeric) ? numeric * (numeric < 10_000_000_000 ? 1000 : 1) : Date.parse(String(raw ?? "")); if (id && Number.isFinite(last) && last <= cutoff) await finalize(id); } } catch (error) { appendEvent("trajectory.synchronization-failed", { message: error instanceof Error ? error.message : String(error) }); } };
	return { app, synchronize };
}

if (process.env.NODE_ENV !== "test") { const controller = createLabController(); serve({ fetch: controller.app.fetch, hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8081) }); setInterval(() => void controller.synchronize(), 30_000); }
