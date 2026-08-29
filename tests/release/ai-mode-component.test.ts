import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { modeEndpoint, modeRequest } from "../../packages/lab/src/mode-control.js";

describe("Deployment-managed AI mode component boundary", () => {
	it("emits the fixed gate status and preserves the active counter", () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-gate-")), gate = join(root, "gate.json"), activity = join(root, "status.json");
		writeFileSync(activity, JSON.stringify({ activeGpuJobs: 2 }));
		const environment = { ...process.env, TREESEED_GPU_ADMISSION_FILE: gate, TREESEED_GPU_ACTIVITY_FILE: activity };
		const close = JSON.parse(execFileSync(process.execPath, ["containers/common/gpu-gate.mjs", "close"], { env: environment, encoding: "utf8" }));
		expect(close).toEqual({ admission: "closed", active: 2 });
		const open = JSON.parse(execFileSync(process.execPath, ["containers/common/gpu-gate.mjs", "open"], { env: environment, encoding: "utf8" }));
		expect(open).toEqual({ admission: "open", active: 2 });
	});

	it("uses the SDK request schema and only manager-generated mTLS material", () => {
		expect(modeRequest("sleep", "library-cycle:1", 900)).toEqual({ schemaVersion: "treeseed.ai-mode-request/v1", target: "sleep", idempotencyKey: "library-cycle:1", drainTimeoutSeconds: 900 });
		expect(modeEndpoint({ TREESEED_AI_MODE_URL: "https://host.docker.internal:4790/v1/ai/mode" }).pathname).toBe("/v1/ai/mode");
		expect(() => modeEndpoint({ TREESEED_AI_MODE_URL: "https://host.docker.internal:4790/v1/status" })).toThrow(/HTTPS \/v1\/ai\/mode/u);
		expect(() => modeEndpoint({ TREESEED_AI_MODE_URL: "http://host.docker.internal:4790/v1/ai/mode" })).toThrow(/HTTPS \/v1\/ai\/mode/u);
		const compose = YAML.parse(readFileSync("deploy/lab/compose.yml", "utf8"));
		expect(compose["x-lab-environment"].TREESEED_AI_MODE_URL).toContain("TREESEED_AI_MODE_URL");
		expect(compose.services.controller.secrets).toEqual(expect.arrayContaining(["ai-mode-ca", "ai-mode-client-cert", "ai-mode-client-key"]));
		expect(compose.secrets["ai-mode-client-key"].file).toBe("/etc/treeseed/credentials/ai-mode-client.key");
		expect(JSON.stringify(compose)).not.toContain("factory-control-key");
	});

	it("keeps GPU services out of mode-safe base dependencies", () => {
		const compose = YAML.parse(readFileSync("deploy/component/compose.template.yml", "utf8"));
		expect(compose.services["inference-api"].depends_on).not.toHaveProperty("inference-vllm");
		expect(compose.services["training-manager"].depends_on).not.toHaveProperty("training-marker");
		expect(compose.services["inference-manager"].environment.TREESEED_GPU_ADMISSION_FILE).toBe("/run/treeseed-ai/gate.json");
		expect(compose.services["inference-vllm"].environment.TREESEED_VLLM_MODEL).toBe("${PUBLIC_MODEL:-local-model}");
		expect(compose.services["inference-vllm"].environment.VLLM_CACHE_ROOT).toBe("/models/vllm-cache");
		expect(compose.services["inference-vllm"].command).toEqual(expect.arrayContaining([
			"--max-num-seqs", "${MAX_NUM_SEQS:-2}",
			"--gpu-memory-utilization", "${GPU_MEMORY_UTILIZATION:-0.85}",
		]));
		expect(readFileSync("containers/inference/api.Dockerfile", "utf8")).toContain("/usr/local/bin/treeseed-ai-gpu-gate");
		expect(readFileSync("containers/training/api.Dockerfile", "utf8")).toContain("/usr/local/bin/treeseed-ai-gpu-gate");
		expect(readFileSync("containers/inference/vllm.Dockerfile", "utf8")).toContain("/usr/local/bin/treeseed-ai-warm");
	});
});
