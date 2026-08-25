import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredContext, contextPolicy, fingerprint, probeCandidate } from "../../../packages/manager/src/lifecycle/qualification/index.js";

describe("machine qualification", () => {
	afterEach(() => { delete process.env.TREEAI_QUALIFICATION_ROOT; delete process.env.TREEAI_MANAGER_DB; vi.resetModules(); });
	it("builds tokenizer budget policies without exceeding context", () => {
		const value = contextPolicy(32768);
		expect(value.outputReserve).toBeGreaterThanOrEqual(2048);
		expect(value.systemBudget + value.toolSchemaBudget + value.recentHistoryBudget + value.structuredMemoryBudget + value.toolResultBudget + value.outputReserve).toBeLessThanOrEqual(value.contextTokens);
		expect(value.compactionThreshold).toBeLessThan(value.contextTokens);
	});
	it("fingerprints the GPU and relevant image identities", () => {
		const run = (file: string, args: string[]) => file === "nvidia-smi" ? "GPU-1, RTX 3080, 16384, 595.84" : args.includes("info") ? '{"path":"nvidia-container-runtime"}' : `sha256:${args[2]}`;
		const value = fingerprint(run);
		expect(value.gpuUuid).toBe("GPU-1");
		expect(value.gpuMemoryMiB).toBe(16384);
		expect(value.images["inference-vllm"]).toMatch(/^sha256:/u);
		expect(value.baseRevision).toHaveLength(40);
	});
	it("rejects requested contexts above the empirically running profile", () => {
		const fp = fingerprint((file, args) => file === "nvidia-smi" ? "GPU-1, RTX 3080, 16384, 595.84" : args.includes("info") ? '{"path":"nvidia"}' : "sha256:image");
		const run = (_file: string, args: string[]) => args.includes("treeseed-ai-inference-vllm-1") && args.includes("inspect") ? '["--model","Qwen/Qwen3.5-4B","--max-model-len","16384"]' : args.some((item) => item.includes("concurrent.futures")) ? '{"latencyMs":100,"successes":2}' : args.includes("sh") ? "failed" : "ready";
		const settings = { maxModelLength: 32768, maxSequences: 2, gpuMemoryUtilization: .85, trainingSequenceLength: 4096, multimodalSequenceLength: 2048, maxImagePixels: 262144, loraRank: 16, multimodalLoraEnabled: false };
		const result = probeCandidate(fp, settings, run);
		expect(result.gates.inferenceContext).toBe(false);
		expect(result.multimodal).toBe(false);
		expect(result.multimodalDiagnostic).toBe("runtime_flag_not_active");
	});
	it("reads the effective context from the production vLLM command", () => {
		expect(configuredContext('["--model","Qwen/Qwen3.5-4B","--max-model-len","16384","--enable-lora"]')).toBe(16384);
		expect(configuredContext('["--max-model-len","invalid"]')).toBe(0);
		expect(configuredContext("not-json")).toBe(0);
	});
	it("does not treat successful empty probe output as a multimodal failure", () => {
		const fp = fingerprint((file, args) => file === "nvidia-smi" ? "GPU-1, RTX 3080, 16384, 595.84" : args.includes("info") ? '{"path":"nvidia"}' : "sha256:image");
		const run = (_file: string, args: string[]) => args.includes("inspect") && args.some((item) => item.includes("Config.Cmd")) ? '["--max-model-len","16384"]' : args.some((item) => item.includes("concurrent.futures")) ? '{"latencyMs":100,"successes":2}' : args.some((item) => item.includes("printf true")) ? "true" : "ready";
		const settings = { maxModelLength: 16384, maxSequences: 2, gpuMemoryUtilization: .85, trainingSequenceLength: 4096, multimodalSequenceLength: 4096, maxImagePixels: 262144, loraRank: 16, multimodalLoraEnabled: false };
		expect(probeCandidate(fp, settings, run)).toMatchObject({ multimodal: true, multimodalDiagnostic: undefined });
	});
	it("creates first-run campaign directories and reuses the root-observed fingerprint", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-qualification-"));
		process.env.TREEAI_QUALIFICATION_ROOT = join(root, "qualification");
		process.env.TREEAI_MANAGER_DB = join(root, "manager.db");
		const module = await import("../../../packages/manager/src/lifecycle/qualification/index.js?first-run");
		const run = (file: string, args: string[]) => {
			if (file === "nvidia-smi") return "GPU-1, RTX 3080, 16384, 595.84";
			if (args.includes("info")) return '{"path":"nvidia-container-runtime"}';
			if (args.includes("inspect") && args.includes("treeseed-ai-inference-vllm-1") && args.some((item) => item.includes("Config.Cmd"))) return '["--model","Qwen/Qwen3.5-4B","--max-model-len","16384"]';
			if (args.some((item) => item.includes("concurrent.futures"))) return '{"latencyMs":100,"successes":2}';
			if (args.includes("sh")) return "failed";
			return "sha256:image";
		};
		const campaign = module.runCampaign("baseline", run);
		expect(campaign.state).toBe("succeeded");
		expect(module.campaign(campaign.id)?.id).toBe(campaign.id);
		const status = module.qualificationStatus();
		expect(status.fingerprint.images["inference-vllm"]).toBe("sha256:image");
	});
});
