import { mkdtempSync,readFileSync,writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredContext, contextPolicy, fingerprint, observedTrainingProfile, probeCandidate,profileCompatible,scoresComparable, supportedLoraRank } from "../../../packages/manager/src/lifecycle/qualification/index.js";

describe("machine qualification", () => {
	afterEach(() => { delete process.env.TREEAI_QUALIFICATION_ROOT; delete process.env.TREEAI_MANAGER_DB; delete process.env.TREEAI_TRAINING_PROFILE_RECEIPT; vi.resetModules(); });
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
	it("fails closed when a profile advertises a LoRA rank the fixed trainers do not apply", () => {
		const fp = fingerprint((file, args) => file === "nvidia-smi" ? "GPU-1, RTX 3080, 16384, 595.84" : args.includes("info") ? '{"path":"nvidia"}' : "sha256:image");
		const run = (_file: string, args: string[]) => args.includes("inspect") && args.some((item) => item.includes("Config.Cmd")) ? '["--max-model-len","16384"]' : args.some((item) => item.includes("concurrent.futures")) ? '{"latencyMs":100,"successes":2}' : args.includes("sh") ? "failed" : "ready";
		const settings = { maxModelLength: 16384, maxSequences: 2, gpuMemoryUtilization: .85, trainingSequenceLength: 3072, multimodalSequenceLength: 2048, maxImagePixels: 262144, loraRank: 32, multimodalLoraEnabled: false };
		expect(supportedLoraRank).toBe(16);
		expect(probeCandidate(fp, settings, run).gates.loraRank).toBe(false);
		expect(profileCompatible({ settings })).toBe(false);
		expect(profileCompatible({ settings: { ...settings, loraRank: supportedLoraRank } })).toBe(true);
	});
	it("reads the effective context from the production vLLM command", () => {
		expect(configuredContext('["--model","Qwen/Qwen3.5-4B","--max-model-len","16384","--enable-lora"]')).toBe(16384);
		expect(configuredContext('["--max-model-len","invalid"]')).toBe(0);
		expect(configuredContext("not-json")).toBe(0);
	});
	it("accepts only bounded sustained training receipts",()=>{const root=mkdtempSync(join(tmpdir(),"treeai-training-profile-")),path=join(root,"profile.json");writeFileSync(path,JSON.stringify({schemaVersion:"treeai.sustained-training-profile/v1",fingerprint:"gpu-runtime",sequenceLength:3072,diagnostics:{failed:[4096]},qualifiedAt:"2026-08-25T00:00:00.000Z"}));expect(observedTrainingProfile(path)).toMatchObject({sequenceLength:3072,fingerprint:"gpu-runtime"});writeFileSync(path,JSON.stringify({schemaVersion:"treeai.sustained-training-profile/v1",fingerprint:"gpu-runtime",sequenceLength:5000}));expect(observedTrainingProfile(path)).toBeNull();});
	it("compares strict improvement only within the same signed score policy",()=>{expect(scoresComparable({scorePolicy:"balanced-v2",fingerprintDigest:"host"},{scorePolicy:"balanced-v2",fingerprintDigest:"host"})).toBe(true);expect(scoresComparable({scorePolicy:"balanced-v2",fingerprintDigest:"host"},{fingerprintDigest:"host"})).toBe(false);expect(scoresComparable({scorePolicy:"balanced-v2",fingerprintDigest:"host"},{scorePolicy:"balanced-v2",fingerprintDigest:"other"})).toBe(false);});
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
		const profilePath=join(process.env.TREEAI_QUALIFICATION_ROOT!,"profiles",`${campaign.selectedProfileId}.json`),envelope=JSON.parse(readFileSync(profilePath,"utf8"));
		envelope.profile.settings.loraRank=32;envelope.digest=createHash("sha256").update(JSON.stringify(envelope.profile)).digest("hex");writeFileSync(profilePath,JSON.stringify(envelope));
		expect(module.qualificationStatus()).toMatchObject({status:"warning",baselineRequired:true});
		expect(()=>module.activateProfile(campaign.selectedProfileId!)).toThrow(/compatible/u);
	});
	it("explores and selects the sustained training ceiling before long-context rejections",async()=>{const root=mkdtempSync(join(tmpdir(),"treeai-balanced-")),receipt=join(root,"training-profile.json");process.env.TREEAI_QUALIFICATION_ROOT=join(root,"qualification");process.env.TREEAI_MANAGER_DB=join(root,"manager.db");process.env.TREEAI_TRAINING_PROFILE_RECEIPT=receipt;writeFileSync(receipt,JSON.stringify({schemaVersion:"treeai.sustained-training-profile/v1",fingerprint:"host",sequenceLength:3072,diagnostics:{},qualifiedAt:new Date().toISOString()}));const module=await import("../../../packages/manager/src/lifecycle/qualification/index.js?balanced-selection"),run=(file:string,args:string[])=>file==="nvidia-smi"?"GPU-1, RTX 3080, 16384, 595.84":args.includes("info")?'{"path":"nvidia"}':args.includes("inspect")&&args.some((item)=>item.includes("Config.Cmd"))?'["--max-model-len","16384"]':args.some((item)=>item.includes("concurrent.futures"))?'{"latencyMs":100,"successes":2}':args.includes("sh")?"failed":"sha256:image",campaign=module.runCampaign("balanced",run),selected=module.readProfile(campaign.selectedProfileId!);expect(campaign.state).toBe("succeeded");expect(campaign.trials.length).toBeGreaterThan(7);expect(selected?.settings.trainingSequenceLength).toBe(3072);expect(selected?.settings.loraRank).toBe(16);expect(module.profiles().every((profile)=>profile.settings.loraRank===16)).toBe(true);expect(selected?.metrics.trainingCapacity).toBeCloseTo(3072/8192);});
});
