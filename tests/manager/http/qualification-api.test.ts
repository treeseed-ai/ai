import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "../../../packages/common/src/auth.js";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("manager qualification API", () => {
	it("reports supervisor work as running while the fixed operation executes", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-qualification-api-")), keys = join(root, "keys.json");
		roots.push(root);
		writeFileSync(keys, JSON.stringify([{ id: "operator", hash: hashApiKey("secret", "salt"), scopes: ["*"], revoked: false }]));
		vi.stubEnv("TREEAI_MANAGER_DB", join(root, "lifecycle.db"));
		vi.stubEnv("TREEAI_MANAGER_API_KEYS_FILE", keys);
		vi.stubEnv("TREEAI_QUALIFICATION_ROOT", join(root, "qualification"));
		vi.stubEnv("TREEAI_MANAGER_SOCKET", join(root, "missing.sock"));
		vi.resetModules();
		const { createManagerApp } = await import("../../../packages/manager/src/http/api.js?running");
		const response = await createManagerApp().request("/v1/qualification/campaigns", { method: "POST", headers: { authorization: "Bearer ak_operator_secret", "content-type": "application/json" }, body: JSON.stringify({ preset: "baseline", idempotencyKey: "qualification-running" }) });
		expect(response.status).toBe(202);expect(await response.json()).toMatchObject({ kind: "qualification", state: "running" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const { closeStore } = await import("../../../packages/manager/src/core/store.js");closeStore();
	});
	it("resolves a submitted work identifier to its completed campaign", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-qualification-api-")), keys = join(root, "keys.json");
		roots.push(root);
		writeFileSync(keys, JSON.stringify([{ id: "operator", hash: hashApiKey("secret", "salt"), scopes: ["*"], revoked: false }]));
		vi.stubEnv("TREEAI_MANAGER_DB", join(root, "lifecycle.db"));
		vi.stubEnv("TREEAI_MANAGER_API_KEYS_FILE", keys);
		vi.stubEnv("TREEAI_QUALIFICATION_ROOT", join(root, "qualification"));
		vi.resetModules();
		const { createManagerApp } = await import("../../../packages/manager/src/http/api.js");
		const { createWork, finishWork, closeStore } = await import("../../../packages/manager/src/core/store.js");
		const work = createWork("qualification", "qualification-1", { preset: "baseline" });
		const campaign = { id: "campaign-1", preset: "baseline", state: "succeeded" };
		finishWork(work.id, "succeeded", campaign);
		const response = await createManagerApp().request(`/v1/qualification/campaigns/${work.id}`, { headers: { authorization: "Bearer ak_operator_secret" } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(campaign);
		closeStore();
	});
});
