import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qualificationImageBase64 } from "../../../packages/manager/src/lifecycle/qualification/canaries.js";
import { diagnostic, qualifyMultimodalSupport, setMultimodalFlag } from "../../../packages/manager/src/lifecycle/qualification/multimodal.js";

function fixture(active = 0) {
	const root = mkdtempSync(join(tmpdir(), "treeai-mm-probe-")), environment = join(root, "environment"), status = join(root, "status.json");
	writeFileSync(environment, "MAX_MODEL_LENGTH=16384\nTREEAI_MULTIMODAL_LORA_ENABLED=false\n", { mode: 0o640 });
	writeFileSync(status, JSON.stringify({ active }));
	return { environment, status };
}
describe("multimodal qualification bootstrap", () => {
	it("uses a deterministic image large enough for multimodal processors", () => {
		const image = Buffer.from(qualificationImageBase64, "base64");
		expect(image.subarray(1, 4).toString()).toBe("PNG");
		expect(image.readUInt32BE(16)).toBe(64);
		expect(image.readUInt32BE(20)).toBe(64);
	});
	it("bounds and redacts fixed-probe diagnostics", () => {
		const value = diagnostic({ stderr: `Bearer secret /etc/treeseed-ai/private ${"x".repeat(800)}` });
		expect(value).not.toContain("secret");expect(value).not.toContain("/etc/");expect(value.length).toBeLessThanOrEqual(512);
	});
	it("changes only the managed flag", () => expect(setMultimodalFlag("A=1\nTREEAI_MULTIMODAL_LORA_ENABLED=false\n", true)).toBe("A=1\nTREEAI_MULTIMODAL_LORA_ENABLED=true\n"));
	it("postpones without mutation while inference is active", () => {
		const paths = fixture(1), before = readFileSync(paths.environment, "utf8"), calls: string[][] = [];
		expect(qualifyMultimodalSupport((_file, args) => { calls.push(args); return ""; }, paths)).toMatchObject({ supported: false, attempted: false, reason: "active_inference" });
		expect(readFileSync(paths.environment, "utf8")).toBe(before);expect(calls).toHaveLength(0);
	});
	it("enables and validates the fixed private vLLM canary", () => {
		const paths = fixture(), calls: string[][] = [];
		expect(qualifyMultimodalSupport((_file, args) => { calls.push(args); return "ready"; }, paths)).toMatchObject({ supported: true, changed: true });
		expect(readFileSync(paths.environment, "utf8")).toContain("TREEAI_MULTIMODAL_LORA_ENABLED=true");expect(calls.some((args) => args.includes("vllm"))).toBe(true);expect(calls.some((args) => args.includes("exec"))).toBe(true);
	});
	it("restores the environment and service after canary failure", () => {
		const paths = fixture(), before = readFileSync(paths.environment, "utf8");let executions = 0;
		const result = qualifyMultimodalSupport((_file, args) => { if (args.includes("exec")) { executions++; throw new Error("canary failed"); } return ""; }, paths);
		expect(result).toMatchObject({ supported: false, reason: "probe_failed_and_restored", diagnostic: "canary failed" });expect(readFileSync(paths.environment, "utf8")).toBe(before);expect(executions).toBe(1);
	});
});
