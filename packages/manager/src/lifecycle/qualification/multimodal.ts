import { execFileSync } from "node:child_process";
import { chownSync, chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { redactSensitiveText } from "@ai-platform/common";
import { imageCanary } from "./canaries.js";

type Runner = (file: string, args: string[]) => string;
const environment = "/etc/treeseed-ai/inference/environment";
const status = "/run/treeseed-ai/inference/status.json";
const compose = ["compose", "-p", "treeseed-ai-inference", "--env-file", environment, "-f", "/usr/lib/treeseed-ai/inference/compose.yml", "-f", "/usr/lib/treeseed-ai/inference/factory.override.yml"];
const canary = imageCanary("Reply image-ready.");
const defaultRunner: Runner = (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

function active(path: string) {
	try { return Number((JSON.parse(readFileSync(path, "utf8")) as { active?: number }).active ?? 0); } catch { return 0; }
}
export function setMultimodalFlag(value: string, enabled: boolean) {
	const line = `TREEAI_MULTIMODAL_LORA_ENABLED=${enabled ? "true" : "false"}`;
	return /^TREEAI_MULTIMODAL_LORA_ENABLED=.*$/mu.test(value) ? value.replace(/^TREEAI_MULTIMODAL_LORA_ENABLED=.*$/mu, line) : `${value.trimEnd()}\n${line}\n`;
}
function atomic(path: string, value: string) {
	const metadata = statSync(path), next = `${path}.qualification-${process.pid}`;
	writeFileSync(next, value, { mode: metadata.mode & 0o777 });chmodSync(next, metadata.mode & 0o777);chownSync(next, metadata.uid, metadata.gid);renameSync(next, path);
}
function restart(run: Runner) { run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "900", "vllm"]); }
function runtimeEnabled(run: Runner) {
	try { return run("docker", ["exec", "treeseed-ai-inference-vllm-1", "sh", "-lc", "test \"${TREEAI_MULTIMODAL_LORA_ENABLED:-false}\" = true && printf true || printf false"]) === "true"; }
	catch { return undefined; }
}
export function diagnostic(error: unknown) {
	const value = error as { message?: string; stderr?: string | Buffer }, raw = String(value.stderr ?? value.message ?? error);
	return redactSensitiveText(raw).replace(/\/(?:etc|home|run|var)\/[^\s:'"]+/gu, "[path]").replace(/\s+/gu, " ").trim().slice(0, 512);
}
export function qualifyMultimodalSupport(run: Runner = defaultRunner, paths = { environment, status }) {
	if (active(paths.status) > 0) return { supported: false, attempted: false, reason: "active_inference" };
	if (!existsSync(paths.environment)) return { supported: false, attempted: false, reason: "environment_missing" };
	const prior = readFileSync(paths.environment, "utf8"), enabled = setMultimodalFlag(prior, true), observed = runtimeEnabled(run);
	if (enabled === prior && observed === true) {
		try { run("docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", canary]); return { supported: true, attempted: true, changed: false }; }
		catch (error) { return { supported: false, attempted: true, changed: false, reason: "image_canary_failed", diagnostic: diagnostic(error) }; }
	}
	try {
		if (enabled !== prior) atomic(paths.environment, enabled);restart(run);run("docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", canary]);
		return { supported: true, attempted: true, changed: true };
	} catch (error) {
		const restored = observed === false ? setMultimodalFlag(prior, false) : prior;
		atomic(paths.environment, restored);
		try { restart(run); } catch (restore) { throw new Error(`Multimodal probe failed and vLLM restoration failed: ${error instanceof Error ? error.message : String(error)}; ${restore instanceof Error ? restore.message : String(restore)}`); }
		return { supported: false, attempted: true, changed: false, reason: "probe_failed_and_restored", diagnostic: diagnostic(error) };
	}
}
