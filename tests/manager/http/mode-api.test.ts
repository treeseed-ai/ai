import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashApiKey } from "../../../packages/common/src/auth.js";
const {supervisor}=vi.hoisted(()=>({supervisor:vi.fn(async(request:{parameters?:{mode?:string}})=>({mode:request.parameters?.mode,changed:false,reconciled:true}))}));
vi.mock("../../../packages/manager/src/lifecycle/socket.js",()=>({callSupervisor:supervisor}));

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("manager mode API", () => {
	it("reattaches interrupted transitions after an API restart", async () => {
		const root=mkdtempSync(join(tmpdir(),"treeai-transition-recovery-"));roots.push(root);vi.stubEnv("TREEAI_MANAGER_DB",join(root,"lifecycle.db"));vi.resetModules();
		const store=await import("../../../packages/manager/src/core/store.js"),api=await import("../../../packages/manager/src/http/api.js"),old=store.createWork("transition","restart-sleep",{mode:"sleep"});store.finishWork(old.id,"running");const work=store.createWork("transition","restart-awake",{mode:"awake"});store.finishWork(work.id,"running");
		const supervisor=vi.fn(async()=>({mode:"awake",changed:true}));await api.recoverInterruptedTransitions(supervisor);
		expect(supervisor).toHaveBeenCalledTimes(1);expect(supervisor).toHaveBeenCalledWith({operation:"mode.set",parameters:{mode:"awake"},idempotencyKey:"restart-awake"});expect(store.getWork(old.id)).toMatchObject({state:"failed",error:expect.stringContaining("superseded")});expect(store.getWork(work.id)).toMatchObject({state:"succeeded",result:{mode:"awake",changed:true}});store.closeStore();
	});
	it("reconciles even when the requested mode matches persisted state", async () => {
		const root = mkdtempSync(join(tmpdir(), "treeai-mode-api-")), keys = join(root, "keys.json");
		roots.push(root);
		writeFileSync(keys, JSON.stringify([{ id: "operator", hash: hashApiKey("secret", "salt"), scopes: ["*"], revoked: false }]));
		vi.stubEnv("TREEAI_MANAGER_DB", join(root, "lifecycle.db"));
		vi.stubEnv("TREEAI_MANAGER_API_KEYS_FILE", keys);
		vi.resetModules();
		const { createManagerApp } = await import("../../../packages/manager/src/http/api.js");
		const response = await createManagerApp().request("/v1/mode", { method: "POST", headers: { authorization: "Bearer ak_operator_secret", "content-type": "application/json" }, body: JSON.stringify({ mode: "awake", idempotencyKey: "same-mode-1" }) }), value = await response.json() as any;
		expect(response.status).toBe(202);
		expect(value).toMatchObject({ kind: "transition", state: "running" });await vi.waitFor(()=>expect(supervisor).toHaveBeenCalledWith(expect.objectContaining({operation:"mode.set",parameters:{mode:"awake"}})));
		const duplicate = await createManagerApp().request("/v1/mode", { method: "POST", headers: { authorization: "Bearer ak_operator_secret", "content-type": "application/json" }, body: JSON.stringify({ mode: "awake", idempotencyKey: "same-mode-1" }) });
		expect((await duplicate.json() as any).id).toBe(value.id);
		const { closeStore } = await import("../../../packages/manager/src/core/store.js");
		closeStore();
	});
});
