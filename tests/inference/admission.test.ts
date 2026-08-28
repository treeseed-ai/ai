import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "../../packages/common/src/index.js";
import { createInferenceGateway } from "../../packages/inference-api/src/gateway.js";

const record = { id: "mode", hash: hashApiKey("invoke", "salt"), scopes: ["inference:invoke"], revoked: false }, headers = { authorization: "Bearer ak_mode_invoke", "content-type": "application/json" };
const original = process.env.TREESEED_GPU_ADMISSION_FILE;
afterEach(() => { if (original === undefined) delete process.env.TREESEED_GPU_ADMISSION_FILE; else process.env.TREESEED_GPU_ADMISSION_FILE = original; });

describe("managed inference admission", () => {
	it("fails closed until Deployment opens the gate", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-admission-")), gate = join(root, "gate.json");
		process.env.TREESEED_GPU_ADMISSION_FILE = gate;
		const upstream = vi.fn(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));
		const app = createInferenceGateway({ rawVllmUrl: "http://vllm:8000", publicModel: "local-model", sourceModel: "base", resolveKey: async (id) => id === "mode" ? record : null, fetch: upstream as typeof fetch });
		const body = JSON.stringify({ model: "local-model", messages: [{ role: "user", content: "test" }] });
		expect((await app.request("/v1/chat/completions", { method: "POST", headers, body })).status).toBe(503);
		expect(upstream).not.toHaveBeenCalled();
		writeFileSync(gate, JSON.stringify({ admission: "open" }));
		expect((await app.request("/v1/chat/completions", { method: "POST", headers, body })).status).toBe(200);
		expect(upstream).toHaveBeenCalledOnce();
	});
});
