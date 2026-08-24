import { describe, expect, it } from "vitest";
import { contextPolicy, fingerprint } from "../../packages/manager/src/lifecycle/qualification.js";

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
		expect(value.images["inference-vllm"]).toContain("inference-vllm");
		expect(value.baseRevision).toHaveLength(40);
	});
});
