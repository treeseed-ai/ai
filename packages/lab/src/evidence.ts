import type { AgentActionSequenceV1, AgentTrajectoryEvent, AgentTrajectoryV1, ArtifactObservationV1, KtoLabelRevision } from "./contracts.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { appendBounded, appendEvent, atomic, digest, lines, readJson, redactKnownCredentials, sanitize, stateRoot, workspaceRoot } from "./shared.js";

type HermesMessage = { id?: string | number; role?: string; content?: unknown; tool_name?: string; tool_call_id?: string; tool_calls?: unknown; timestamp?: string | number; token_count?: number; reasoning?: unknown };
type HermesSession = { id?: string; session_id?: string; source?: string; model?: string; created_at?: string | number; started_at?: string | number; last_active?: string | number; end_reason?: string };

const textual = new Set([".txt", ".md", ".json", ".jsonl", ".csv", ".yaml", ".yml", ".xml", ".html", ".js", ".ts", ".py", ".sh"]);
function mime(path: string) { return ({ ".md": "text/markdown", ".json": "application/json", ".jsonl": "application/x-ndjson", ".html": "text/html", ".csv": "text/csv", ".txt": "text/plain" } as Record<string, string>)[extname(path).toLowerCase()] ?? "application/octet-stream"; }
function iso(value: unknown, fallback?: string) {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value * (value < 10_000_000_000 ? 1000 : 1)).toISOString();
	if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
	return fallback;
}
export function sanitizeEvidence(value: unknown): unknown {
	const clean = sanitize(value);
	if (typeof clean === "string") return clean
		.replaceAll(`${workspaceRoot}/`, "").replaceAll("/workspace/", "")
		.replace(/\/(?:etc|var|run|proc|sys|dev|tmp|root|usr|opt)(?:\/[A-Za-z0-9._@%+=:,~-]+)+/gu, "[REDACTED_PATH]");
	if (Array.isArray(clean)) return clean.map(sanitizeEvidence);
	if (clean && typeof clean === "object") return Object.fromEntries(Object.entries(clean).map(([key, item]) => [key, sanitizeEvidence(item)]));
	return clean;
}

export function normalizeEvents(messages: HermesMessage[]): AgentTrajectoryEvent[] {
	return messages.flatMap((message, index) => {
		const role = message.role;
		if (!role || !["system", "user", "assistant", "tool"].includes(role)) return [];
		const value: AgentTrajectoryEvent = { id: String(message.id ?? `event-${index}`), role: role as AgentTrajectoryEvent["role"], content: sanitizeEvidence(message.content) };
		if (message.tool_name) value.toolName = message.tool_name;
		if (message.tool_call_id) value.toolCallId = message.tool_call_id;
		if (message.tool_calls) value.toolArguments = sanitizeEvidence(message.tool_calls);
		const timestamp = iso(message.timestamp); if (timestamp) value.timestamp = timestamp;
		if (Number.isFinite(message.token_count)) value.tokenCount = message.token_count;
		return [value];
	});
}

export function actionSequences(trajectoryId: string, events: AgentTrajectoryEvent[]) {
	const result: AgentActionSequenceV1[] = [];
	for (let start = 0; start < events.length; start++) {
		if (events[start]?.role !== "assistant") continue;
		let end = start;
		while (end + 1 < events.length && ["assistant", "tool"].includes(events[end + 1]!.role)) end++;
		const sequence = events.slice(start, end + 1), id = digest({ trajectoryId, start, sequence });
		result.push({ schemaVersion: "ai.agent-action-sequence/v1", id, trajectoryId, startEvent: start, endEvent: end, events: sequence, eligibility: { correctiveSft: true, kto: true } });
		start = end;
	}
	return result;
}

export function observeArtifacts(trajectoryId: string, roots = { workspace: workspaceRoot, state: stateRoot }): ArtifactObservationV1[] {
	const root = realpathSync(roots.workspace), observations: ArtifactObservationV1[] = [],
		snapshotPath = `${roots.state}/workspace-snapshot.json`, previous = readJson<Record<string, string>>(snapshotPath, {}), next: Record<string, string> = {};
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		const path = resolve(entry.parentPath, entry.name);
		if (entry.isSymbolicLink()) throw new Error("Hermes workspace contains a forbidden symlink");
		if (!entry.isFile()) continue;
		const real = realpathSync(path), relativePath = relative(root, real);
		if (!relativePath || relativePath.startsWith("..")) throw new Error("Workspace path escape");
		let raw: Buffer;
		try { raw = readFileSync(real); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EACCES" && code !== "EPERM") throw error;
			const unavailable = `unavailable:${code}`;
			next[relativePath] = unavailable;
			if (previous[relativePath] !== unavailable) appendEvent("artifact.unavailable", { relativePath, reason: code }, roots.state);
			continue;
		}
		const extension = extname(relativePath).toLowerCase();
		const bytes = textual.has(extension) ? Buffer.from(redactKnownCredentials(raw.toString("utf8"))) : raw;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const objectRoot = `${roots.state}/artifact-objects/sha256`, objectPath = `${objectRoot}/${sha256}`;
		if (!existsSync(objectPath)) {
			mkdirSync(objectRoot, { recursive: true, mode: 0o700 });
			const temporary = `${objectPath}.${process.pid}.tmp`;
			writeFileSync(temporary, bytes, { mode: 0o600 }); renameSync(temporary, objectPath);
		}
		next[relativePath] = sha256;
		if (previous[relativePath] === sha256) continue;
		observations.push({ schemaVersion: "ai.artifact-observation/v1", id: digest({ trajectoryId, relativePath, sha256 }), trajectoryId, relativePath, sha256, size: bytes.byteLength, mimeType: mime(relativePath), observedAt: new Date().toISOString(), provenance: { source: "hermes-workspace", objectReference: `sha256:${sha256}`, revision: previous[relativePath] ? "changed" : "created", redacted: textual.has(extension) && !raw.equals(bytes), libraryIds: ["default"], documentTags: [] } });
	}
	atomic(snapshotPath, next);
	return observations;
}

export function finalizeEvidence(session: HermesSession, messages: HermesMessage[], sourceClient: AgentTrajectoryV1["sourceClient"] = "hermes-api") {
	const hermesSessionId = String(session.id ?? session.session_id ?? "");
	if (!hermesSessionId || !/^[A-Za-z0-9._-]{1,128}$/u.test(hermesSessionId)) throw new Error("Invalid Hermes session identifier");
	const events = normalizeEvents(messages), trajectoryId = digest({ hermesSessionId, events });
	const existing = lines(`${stateRoot}/trajectories.jsonl`).find((item) => item.id === trajectoryId) as AgentTrajectoryV1 | undefined;
	if (existing) return existing;
	const sequences = actionSequences(trajectoryId, events), artifacts = observeArtifacts(trajectoryId), now = new Date().toISOString(), sessionCapture = lines(`${stateRoot}/inference-captures-v2.jsonl`).reverse().find((item) => item.sourceClient === "hermes" && item.hermesSessionId === hermesSessionId) as { resolvedDeployment?: { deploymentRevision?: string } } | undefined;
	const trajectory: AgentTrajectoryV1 = { schemaVersion: "ai.agent-trajectory/v1", id: trajectoryId, hermesSessionId, sourceClient, createdAt: iso(session.started_at ?? session.created_at, now)!, finalizedAt: now, model: session.model ?? "hermes-agent", deploymentRevision: sessionCapture?.resolvedDeployment?.deploymentRevision ?? "unknown", events, actionSequenceIds: sequences.map((item) => item.id), artifactObservationIds: artifacts.map((item) => item.id), eligibility: { continualPretraining: { eligible: false, libraryIds: ["default"], documentTags: [] }, correctiveSft: { eligible: sequences.length > 0 }, kto: { eligible: sequences.length > 0 } } };
	for (const sequence of sequences) appendBounded(`${stateRoot}/action-sequences.jsonl`, sequence);
	for (const artifact of artifacts) if (!lines(`${stateRoot}/artifact-observations.jsonl`).some((item) => item.id === artifact.id)) appendBounded(`${stateRoot}/artifact-observations.jsonl`, artifact);
	appendBounded(`${stateRoot}/trajectories.jsonl`, trajectory);
	return trajectory;
}

export function ktoLabel(input: Omit<KtoLabelRevision, "schemaVersion" | "id" | "label" | "createdAt">): KtoLabelRevision | undefined {
	if (!Number.isFinite(input.score) || input.score < -1 || input.score > 1 || input.score === 0) return undefined;
	if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) return undefined;
	const createdAt = new Date().toISOString(), label = input.score > 0 ? "desirable" as const : "undesirable" as const;
	return { ...input, schemaVersion: "ai.kto-label/v1", id: digest({ ...input, label }), label, createdAt };
}

export function sourceForSession(sessionId: string, hermesSource = "") {
	const match = lines(`${stateRoot}/agent-requests.jsonl`).reverse().find((item) => item.hermesSessionId === sessionId);
	if (match?.sourceClient === "open-webui") return "open-webui" as const;
	return /dashboard|web/iu.test(hermesSource) ? "hermes-dashboard" as const : "hermes-api" as const;
}
