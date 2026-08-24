import { execFileSync } from "node:child_process";
import { chownSync, chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

type Runner = (file: string, args: string[]) => string;
const environment = "/etc/treeseed-ai/inference/environment";
const status = "/run/treeseed-ai/inference/status.json";
const compose = ["compose", "-p", "treeseed-ai-inference", "--env-file", environment, "-f", "/usr/lib/treeseed-ai/inference/compose.yml", "-f", "/usr/lib/treeseed-ai/inference/factory.override.yml"];
const imageCanary = "import base64,json,urllib.request; pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; body=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,'+pixel}},{'type':'text','text':'Reply image-ready.'}]}],'max_tokens':8}).encode(); urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=body,headers={'content-type':'application/json'}),timeout=120).read(); print('ready')";
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
export function qualifyMultimodalSupport(run: Runner = defaultRunner, paths = { environment, status }) {
	if (active(paths.status) > 0) return { supported: false, attempted: false, reason: "active_inference" };
	if (!existsSync(paths.environment)) return { supported: false, attempted: false, reason: "environment_missing" };
	const prior = readFileSync(paths.environment, "utf8"), enabled = setMultimodalFlag(prior, true);
	if (enabled === prior) {
		try { run("docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", imageCanary]); return { supported: true, attempted: true, changed: false }; }
		catch { return { supported: false, attempted: true, changed: false, reason: "image_canary_failed" }; }
	}
	try {
		atomic(paths.environment, enabled);restart(run);run("docker", ["exec", "treeseed-ai-inference-vllm-1", "python3", "-c", imageCanary]);
		return { supported: true, attempted: true, changed: true };
	} catch (error) {
		atomic(paths.environment, prior);
		try { restart(run); } catch (restore) { throw new Error(`Multimodal probe failed and vLLM restoration failed: ${error instanceof Error ? error.message : String(error)}; ${restore instanceof Error ? restore.message : String(restore)}`); }
		return { supported: false, attempted: true, changed: false, reason: "probe_failed_and_restored" };
	}
}
