import { describe, expect, it } from "vitest";
import { contextPolicy, fingerprint, probeCandidate } from "../../../packages/manager/src/lifecycle/qualification/index.js";

describe("machine qualification", () => {
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
		const run = (_file: string, args: string[]) => args.includes("treeseed-ai-inference-vllm-1") && args.includes("inspect") ? "MAX_MODEL_LENGTH=16384" : args.some((item) => item.includes("concurrent.futures")) ? '{"latencyMs":100,"successes":2}' : args.includes("sh") ? "failed" : "ready";
		const settings = { maxModelLength: 32768, maxSequences: 2, gpuMemoryUtilization: .85, trainingSequenceLength: 4096, multimodalSequenceLength: 2048, maxImagePixels: 262144, loraRank: 16, multimodalLoraEnabled: false };
		const result = probeCandidate(fp, settings, run);
		expect(result.gates.inferenceContext).toBe(false);
		expect(result.multimodal).toBe(false);
	});
});
