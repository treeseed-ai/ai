import { describe, expect, it } from "vitest";
import {
	normalizeStoredComponents,
	summarizeComposeStatus,
} from "../../packages/manager/src/lifecycle/status.js";

describe("manager component status", () => {
	it("reduces Compose JSONL to a stable public summary", () => {
		const raw = [
			{
				Service: "api",
				State: "running",
				Health: "healthy",
				Image: "treeseed/inference-api@sha256:abc",
				Command: "node server.js",
				Labels: "secret=no",
				Mounts: "/host/path",
			},
			{
				Service: "manager",
				State: "running",
				Status: "Up 2 minutes",
				Image: "treeseed/inference-manager@sha256:def",
			},
		]
			.map((value) => JSON.stringify(value))
			.join("\n");
		const status = summarizeComposeStatus("inference", raw);
		expect(status).toEqual({
			product: "inference",
			state: "ready",
			services: [
				{
					name: "api",
					state: "running",
					health: "healthy",
					image: "treeseed/inference-api@sha256:abc",
				},
				{
					name: "manager",
					state: "running",
					health: "none",
					image: "treeseed/inference-manager@sha256:def",
				},
			],
		});
		expect(JSON.stringify(status)).not.toMatch(/Command|Labels|Mounts|host\/path/u);
	});

	it("accepts Compose JSON arrays and reports unhealthy products", () => {
		const status = summarizeComposeStatus(
			"lab",
			JSON.stringify([
				{
					Name: "treeseed-ai-lab-hermes-1",
					State: "running",
					Status: "Up 10 seconds (unhealthy)",
					Image: "treeseed/hermes-agent@sha256:abc",
				},
			]),
		);
		expect(status.state).toBe("degraded");
		expect(status.services[0]?.health).toBe("unhealthy");
	});

	it("converts legacy raw component arrays without leaking Compose details", () => {
		const components = normalizeStoredComponents({
			inference: [
				{
					Service: "vllm",
					State: "running",
					Health: "healthy",
					Image: "treeseed/inference-vllm@sha256:abc",
					Labels: "credential=forbidden",
					Mounts: "/etc/secret",
				},
			],
			lab: { state: "managed", composeProject: "treeseed-ai-lab" },
		});
		expect(components).toEqual([
			{
				product: "inference",
				state: "ready",
				services: [
					{
						name: "vllm",
						state: "running",
						health: "healthy",
						image: "treeseed/inference-vllm@sha256:abc",
					},
				],
			},
			{
				product: "lab",
				state: "degraded",
				services: [],
				error: "status_unavailable",
			},
		]);
		expect(JSON.stringify(components)).not.toMatch(
			/Labels|Mounts|credential|etc\/secret/u,
		);
	});

	it("keeps already summarized component records stable", () => {
		const components = normalizeStoredComponents({
			training: {
				product: "training",
				state: "ready",
				services: [
					{
						name: "manager",
						state: "running",
						health: "none",
						image: "treeseed/training-manager@sha256:def",
					},
				],
			},
		});
		expect(components[0]).toEqual({
			product: "training",
			state: "ready",
			services: [
				{
					name: "manager",
					state: "running",
					health: "none",
					image: "treeseed/training-manager@sha256:def",
				},
			],
		});
	});
});
