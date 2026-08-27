import { describe, expect, it, vi } from "vitest";
import {
	verifyLabReadiness,
	verifyProductReadiness,
} from "../../../packages/manager/src/lifecycle/readiness/products.js";

describe("post-reconciliation product readiness", () => {
	it.each([
		["inference", "http://127.0.0.1:4770/readyz"],
		["training", "http://127.0.0.1:4780/readyz"],
	] as const)("probes %s through its private API", (product, endpoint) => {
		const run = vi.fn(() => "");
		verifyProductReadiness(product, run);
		expect(run).toHaveBeenCalledWith(
			product,
			expect.arrayContaining(["exec", "-T", "api", endpoint]),
		);
	});

	it("waits through a bounded API restart window",()=>{
		const run=vi.fn().mockImplementationOnce(()=>{throw new Error("container is restarting");}).mockImplementationOnce(()=>"");const pause=vi.fn();
		expect(verifyProductReadiness("training",run,{attempts:2,pause})).toBe("");expect(run).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledOnce();
	});

	it("waits through a bounded lab controller restart window", () => {
		const run=vi.fn().mockImplementationOnce(()=>{throw new Error("fetch failed");}).mockImplementationOnce(()=>"");const pause=vi.fn();
		expect(verifyLabReadiness(run,{attempts:2,pause})).toBe("");expect(run).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledOnce();
	});

	it("propagates an exhausted lab health gate", () => {
		const error = new Error("503 object store credential rejected");
		expect(() => verifyLabReadiness(() => {
			throw error;
		},{attempts:1})).toThrow(error);
	});
});
