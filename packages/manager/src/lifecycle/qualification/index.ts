import { execFileSync } from "node:child_process";
import { createHash, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { event, setSetting, setting } from "../../core/store.js";
import { paths } from "../../core/paths.js";

export type ProfileName = "interactive" | "agent-long-context" | "training-text" | "training-multimodal";
export interface MachineFingerprint {
	schemaVersion: "treeai.machine-fingerprint/v1";
	gpuUuid: string; gpuModel: string; gpuMemoryMiB: number; driver: string;
	cudaRuntime: string; baseRevision: string; images: Record<string, string>;
}
export interface ContextPolicy {
	schemaVersion: "treeai.agent-context/v1"; contextTokens: number; outputReserve: number;
	systemBudget: number; toolSchemaBudget: number; recentHistoryBudget: number;
	structuredMemoryBudget: number; toolResultBudget: number; compactionThreshold: number;
}
export interface MachineProfile {
	schemaVersion: "treeai.machine-profile/v1"; id: string; name: ProfileName;
	fingerprintDigest: string; fingerprint: MachineFingerprint; state: "candidate" | "active" | "known-good" | "rejected";
	settings: { maxModelLength: number; maxSequences: number; gpuMemoryUtilization: number; trainingSequenceLength: number; multimodalSequenceLength: number; maxImagePixels: number; loraRank: number; multimodalLoraEnabled?: boolean };
	context: ContextPolicy; score: number; gates: Record<string, boolean>; metrics: Record<string, number>; createdAt: string;
}
export interface QualificationCampaign {
	id: string; preset: "baseline" | "balanced"; state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	fingerprintDigest: string; maxTrials: number; deadline: string; trials: Array<{ profileId: string; state: string; score: number; diagnostics?: string }>;
	selectedProfileId?: string; error?: string; createdAt: string; updatedAt: string;
}
type Runner = (file: string, args: string[]) => string;
const defaultRunner: Runner = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 120_000 }).trim();
function atomic(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true, mode: 0o750 }); const next = `${path}.new`; writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 }); renameSync(next, path); }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safe(run: Runner, file: string, args: string[], fallback = "unknown") { try { return run(file, args) || fallback; } catch { return fallback; } }
export function fingerprint(run: Runner = defaultRunner): MachineFingerprint {
	const query = safe(run, "nvidia-smi", ["--query-gpu=uuid,name,memory.total,driver_version", "--format=csv,noheader,nounits"]), [gpuUuid = "unknown", gpuModel = "unknown", memory = "0", driver = "unknown"] = query.split(",").map((item) => item.trim()), roles = ["inference-vllm", "axolotl-worker", "marker-worker"], containers: Record<string, string> = { "inference-vllm": "treeseed-ai-inference-vllm-1", "axolotl-worker": "treeseed-ai-training-axolotl-1", "marker-worker": "treeseed-ai-training-marker-1" }, images: Record<string, string> = {};
	for (const role of roles) images[role] = safe(run, "docker", ["inspect", containers[role]!, "--format", "{{.Image}}"], safe(run, "docker", ["image", "inspect", `local/${role}:0.10.0`, "--format", "{{.Id}}"]));
	return { schemaVersion: "treeai.machine-fingerprint/v1", gpuUuid, gpuModel, gpuMemoryMiB: Number(memory) || 0, driver, cudaRuntime: safe(run, "docker", ["info", "--format", "{{json .Runtimes.nvidia}}"]), baseRevision: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a", images };
}
export function contextPolicy(contextTokens: number): ContextPolicy {
	const outputReserve = Math.max(2048, Math.floor(contextTokens * 0.125)), usable = contextTokens - outputReserve;
	return { schemaVersion: "treeai.agent-context/v1", contextTokens, outputReserve, systemBudget: Math.floor(usable * 0.1), toolSchemaBudget: Math.floor(usable * 0.1), recentHistoryBudget: Math.floor(usable * 0.38), structuredMemoryBudget: Math.floor(usable * 0.12), toolResultBudget: Math.floor(usable * 0.3), compactionThreshold: Math.floor(contextTokens * 0.82) };
}
function signingKey() { const path = process.env.TREEAI_PROFILE_SIGNING_KEY ?? "/etc/treeseed-ai/manager/factory/artifact-signing-key.pem"; return existsSync(path) ? readFileSync(path) : undefined; }
function publicKey() { const path = process.env.TREEAI_PROFILE_PUBLIC_KEY ?? "/etc/treeseed-ai/manager/factory/artifact-signing-public.pem"; return existsSync(path) ? readFileSync(path) : undefined; }
function envelope(profile: MachineProfile) { const payload = Buffer.from(JSON.stringify(profile)), key = signingKey(); return { profile, digest: createHash("sha256").update(payload).digest("hex"), signature: key ? sign(null, payload, key).toString("base64") : null, keyId: key ? "training-local-0.6" : "unsigned-development" }; }
export function verifyProfile(value: ReturnType<typeof envelope>) { const payload = Buffer.from(JSON.stringify(value.profile)); if (value.digest !== createHash("sha256").update(payload).digest("hex")) return false; const key = publicKey(); return value.signature && key ? verify(null, payload, key, Buffer.from(value.signature, "base64")) : process.env.NODE_ENV === "test"; }
function profilePath(id: string) { return join(paths.qualification, "profiles", `${id}.json`); }
function campaignPath(id: string) { return join(paths.qualification, "campaigns", `${id}.json`); }
function observedFingerprint(run?: Runner) {
	if (run) return fingerprint(run);
	const receipt = join(paths.qualification, "fingerprint.json");
	if (existsSync(receipt)) return (JSON.parse(readFileSync(receipt, "utf8")) as { fingerprint: MachineFingerprint }).fingerprint;
	return fingerprint((file, args) => file === "nvidia-smi" ? defaultRunner(file, args) : "unknown");
}
export function qualificationStatus(run?: Runner) { const current = observedFingerprint(run), currentDigest = digest(current), activeId = setting<string | null>("qualification.activeProfile", null), knownGoodId = setting<string | null>("qualification.knownGoodProfile", null); return { status: activeId ? "ready" : "warning", fingerprint: current, fingerprintDigest: currentDigest, baselineRequired: setting("qualification.fingerprint", "") !== currentDigest, activeProfile: activeId ? readProfile(activeId) : null, knownGoodProfile: knownGoodId ? readProfile(knownGoodId) : null }; }
export function activeProfile() { const id = setting<string | null>("qualification.activeProfile", null); return id ? readProfile(id) : null; }
export function readProfile(id: string) { const path = profilePath(id); if (!existsSync(path)) return null; const value = JSON.parse(readFileSync(path, "utf8")) as ReturnType<typeof envelope>; if (!verifyProfile(value)) throw new Error("Machine profile signature is invalid."); return value.profile; }
export function profiles() { const root = join(paths.qualification, "profiles"); if (!existsSync(root)) return []; return (awaitFiles(root)).map((path) => readProfile(path)!).filter(Boolean); }
function awaitFiles(root: string) { return readdirSync(root).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); }
function candidate(name: ProfileName, fp: MachineFingerprint, settings: MachineProfile["settings"], metrics: Record<string, number>, gates: Record<string, boolean>): MachineProfile { const id = crypto.randomUUID(), safe = Object.values(gates).every(Boolean), score = safe ? Number((metrics.quality * .45 + metrics.reliability * .3 + metrics.context * .15 + metrics.latency * .1).toFixed(6)) : 0; return { schemaVersion: "treeai.machine-profile/v1", id, name, fingerprintDigest: digest(fp), fingerprint: fp, state: safe ? "candidate" : "rejected", settings, context: contextPolicy(settings.maxModelLength), score, gates, metrics, createdAt: new Date().toISOString() }; }
const concurrentCanary = "import concurrent.futures,json,urllib.request,time; body=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':'Reply ready.'}],'max_tokens':8}).encode(); f=lambda _: urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=body,headers={'content-type':'application/json'}),timeout=120).read(); start=time.time(); list(concurrent.futures.ThreadPoolExecutor(max_workers=2).map(f,range(2))); print(json.dumps({'latencyMs':(time.time()-start)*1000,'successes':2}))";
const multimodalCanary = "import base64,json,urllib.request; pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; body=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,'+pixel}},{'type':'text','text':'Confirm image input.'}]}],'max_tokens':8}).encode(); urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=body,headers={'content-type':'application/json'}),timeout=120).read(); print('ready')";
function imageProbe(fp: MachineFingerprint, role: string, source: string, run: Runner) {
	const image = fp.images[role];
	if (!image || image === "unknown") return false;
	return safe(run, "docker", ["run", "--rm", "--entrypoint", "python3", image, "-c", source], "failed") !== "failed";
}
export function probeCandidate(fp: MachineFingerprint, settings: MachineProfile["settings"], run: Runner = defaultRunner) {
	const started = Date.now(), gpu = fp.gpuUuid !== "unknown" && fp.gpuMemoryMiB >= 12_000, docker = fp.cudaRuntime !== "unknown";
	const inference = safe(run, "docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", concurrentCanary], "failed");
	let canary: { latencyMs?: number; successes?: number } = {};
	try { canary = JSON.parse(inference) as typeof canary; } catch { /* gate remains false */ }
	const configured = Number(safe(run, "docker", ["inspect", "treeseed-ai-inference-vllm-1", "--format", "{{range .Config.Env}}{{println .}}{{end}}"], "").match(/^MAX_MODEL_LENGTH=(\d+)$/mu)?.[1] ?? 0);
	const axolotl = imageProbe(fp, "axolotl-worker", "import torch,transformers; print('ready')", run);
	const marker = imageProbe(fp, "marker-worker", "import torch,marker; print('ready')", run);
	const multimodalEnabled = safe(run, "docker", ["exec", "treeseed-ai-inference-vllm-1", "sh", "-lc", "test \"${TREEAI_MULTIMODAL_LORA_ENABLED:-false}\" = true"], "failed") !== "failed";
	const multimodal = multimodalEnabled && safe(run, "docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", multimodalCanary], "failed") !== "failed";
	const gates = { gpu, docker, inferenceConcurrency: canary.successes === 2, inferenceContext: configured >= settings.maxModelLength, axolotl, marker, memory: fp.gpuMemoryMiB >= 12_000, bounded: settings.maxModelLength <= 65_536 && settings.trainingSequenceLength <= 8192 };
	const passed = Object.values(gates).filter(Boolean).length;
	return { gates, multimodal, metrics: { quality: passed / Object.keys(gates).length, reliability: canary.successes === 2 && axolotl && marker ? 1 : 0, context: settings.maxModelLength / 65_536, latency: Math.max(0, 1 - Number(canary.latencyMs ?? Date.now() - started) / 120_000), latencyMs: Number(canary.latencyMs ?? Date.now() - started) } };
}
function writeProfile(profile: MachineProfile) { const path = profilePath(profile.id); mkdirSync(join(paths.qualification, "profiles"), { recursive: true, mode: 0o750 }); atomic(path, envelope(profile)); return profile; }
export function activateProfile(id: string) { const next = readProfile(id); if (!next || next.state === "rejected") throw new Error("Only a verified passing profile may be activated."); const priorId = setting<string | null>("qualification.activeProfile", null), prior = priorId ? readProfile(priorId) : null; if (prior && next.score <= prior.score && next.fingerprintDigest === prior.fingerprintDigest) return { changed: false, reason: "not_strictly_better", activeProfile: prior }; if (prior) { prior.state = "known-good"; writeProfile(prior); setSetting("qualification.knownGoodProfile", prior.id); } next.state = "active"; writeProfile(next); setSetting("qualification.activeProfile", next.id); setSetting("qualification.fingerprint", next.fingerprintDigest); event("qualification.profile-activated", { profileId: next.id, priorProfileId: prior?.id }); return { changed: true, activeProfile: next }; }
export function rollbackProfile() { const id = setting<string | null>("qualification.knownGoodProfile", null); if (!id) throw new Error("No known-good machine profile is available."); const profile = readProfile(id); if (!profile) throw new Error("Known-good machine profile is unavailable."); setSetting("qualification.activeProfile", id); setSetting("qualification.fingerprint", profile.fingerprintDigest); event("qualification.profile-rolled-back", { profileId: id }); return profile; }
export function campaigns() { const root = join(paths.qualification, "campaigns"); if (!existsSync(root)) return []; return awaitFiles(root).map((id) => JSON.parse(readFileSync(campaignPath(id), "utf8")) as QualificationCampaign); }
export function campaign(id: string) { const path = campaignPath(id); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as QualificationCampaign : null; }
export function cancelCampaign(id: string) { const value = campaign(id); if (!value || !["queued", "running"].includes(value.state)) throw new Error("Campaign is not cancellable."); value.state = "cancelled"; value.updatedAt = new Date().toISOString(); atomic(campaignPath(id), value); event("qualification.campaign-cancelled", { id }); return value; }
export function runCampaign(preset: "baseline" | "balanced", run: Runner = defaultRunner) {
	const fp = fingerprint(run), createdAt = new Date().toISOString(), maxTrials = preset === "baseline" ? 4 : 24;
	atomic(join(paths.qualification, "fingerprint.json"), { schemaVersion: "treeai.machine-fingerprint-observation/v1", fingerprint: fp, fingerprintDigest: digest(fp), observedAt: createdAt });
	const deadline = new Date(Date.now() + (preset === "baseline" ? 30 * 60_000 : 4 * 60 * 60_000)).toISOString();
	const value: QualificationCampaign = { id: crypto.randomUUID(), preset, state: "running", fingerprintDigest: digest(fp), maxTrials, deadline, trials: [], createdAt, updatedAt: createdAt };
	atomic(campaignPath(value.id), value); event("qualification.campaign-started", { id: value.id, preset });
	const contexts = preset === "baseline" ? [16384] : [16384, 24576, 32768, 49152, 65536];
	const training = preset === "baseline" ? [4096] : [1024, 2048, 3072, 4096, 6144, 8192];
	const names: ProfileName[] = ["interactive", "agent-long-context", "training-text", "training-multimodal"];
	let best = 0, stale = 0;
	for (let index = 0; index < maxTrials && Date.now() < Date.parse(deadline); index++) {
		if (campaign(value.id)?.state === "cancelled") return campaign(value.id)!;
		const name = names[index % names.length]!, maxModelLength = contexts[index % contexts.length]!, trainingSequenceLength = training[Math.floor(index / contexts.length) % training.length]!;
		const settings = { maxModelLength, maxSequences: 2, gpuMemoryUtilization: index % 3 === 2 ? .9 : .85, trainingSequenceLength, multimodalSequenceLength: Math.min(trainingSequenceLength, 4096), maxImagePixels: index % 2 ? 786432 : 262144, loraRank: index % 3 === 2 ? 32 : 16, multimodalLoraEnabled: false };
		const observation = probeCandidate(fp, settings, run); settings.multimodalLoraEnabled = observation.multimodal;
		const gates = { ...observation.gates, ...(name === "training-multimodal" ? { multimodal: observation.multimodal } : {}) };
		const profile = writeProfile(candidate(name, fp, settings, observation.metrics, gates));
		value.trials.push({ profileId: profile.id, state: profile.state, score: profile.score, diagnostics: profile.state === "rejected" ? Object.entries(profile.gates).filter(([, passed]) => !passed).map(([gate]) => gate).join(",") : undefined });
		if (profile.score > best) { best = profile.score; stale = 0; } else stale++;
		value.updatedAt = new Date().toISOString(); atomic(campaignPath(value.id), value);
		if (preset === "balanced" && stale >= 6) break;
	}
	const passing = value.trials.map((trial) => readProfile(trial.profileId)).filter((item): item is MachineProfile => Boolean(item && item.state !== "rejected")).sort((a, b) => b.score - a.score);
	if (!passing.length) { value.state = "failed"; value.error = "No safe machine profile passed empirical capability gates."; }
	else { value.state = "succeeded"; value.selectedProfileId = passing[0]!.id; activateProfile(passing[0]!.id); }
	value.updatedAt = new Date().toISOString(); atomic(campaignPath(value.id), value); event(`qualification.campaign-${value.state}`, { id: value.id, selectedProfileId: value.selectedProfileId });
	return value;
}
