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

describe("manager mode API", () => {
	it("completes a request for the current mode without contacting the supervisor", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-mode-api-")), keys = join(root, "keys.json");
		roots.push(root);
		writeFileSync(keys, JSON.stringify([{ id: "operator", hash: hashApiKey("secret", "salt"), scopes: ["*"], revoked: false }]));
		vi.stubEnv("TREEAI_MANAGER_DB", join(root, "lifecycle.db"));
		vi.stubEnv("TREEAI_MANAGER_API_KEYS_FILE", keys);
		vi.stubEnv("TREEAI_MANAGER_SOCKET", join(root, "missing.sock"));
		vi.resetModules();
		const { createManagerApp } = await import("../../../packages/manager/src/http/api.js");
		const response = await createManagerApp().request("/v1/mode", { method: "POST", headers: { authorization: "Bearer ak_operator_secret", "content-type": "application/json" }, body: JSON.stringify({ mode: "awake", idempotencyKey: "same-mode-1" }) }), value = await response.json() as any;
		expect(response.status).toBe(202);
		expect(value).toMatchObject({ kind: "transition", state: "succeeded", result: { mode: "awake", changed: false, reason: "already_in_mode" } });
		const duplicate = await createManagerApp().request("/v1/mode", { method: "POST", headers: { authorization: "Bearer ak_operator_secret", "content-type": "application/json" }, body: JSON.stringify({ mode: "awake", idempotencyKey: "same-mode-1" }) });
		expect((await duplicate.json() as any).id).toBe(value.id);
		const { closeStore } = await import("../../../packages/manager/src/core/store.js");
		closeStore();
	});
});
