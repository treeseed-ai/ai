import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
	apiKeyAuthorization,
	requireScope,
	type ApiKeyRecord,
} from "@ai-platform/common";
import { paths } from "../core/paths.js";
import {
	callSupervisor,
	type SupervisorOperation,
} from "../lifecycle/socket.js";
import {
	createWork,
	events,
	finishWork,
	getWork,
	setting,
} from "../core/store.js";
import { updateStatus } from "../lifecycle/update.js";
import { normalizeStoredComponents } from "../lifecycle/status.js";
const VERSION = "0.7.0";
function keys(): ApiKeyRecord[] {
	try {
		return JSON.parse(readFileSync(paths.apiKeys, "utf8")) as ApiKeyRecord[];
	} catch {
		return [];
	}
}
function resolve(id: string) {
	return Promise.resolve(keys().find((item) => item.id === id) ?? null);
}
function openapi() {
	const secured = { security: [{ apiKey: [] }] };
	return {
		openapi: "3.1.1",
		info: { title: "TreeAI Manager API", version: VERSION },
		components: {
			securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
		},
		paths: {
			"/healthz": { get: {} },
			"/readyz": { get: {} },
			"/v1/version": { get: secured },
			"/v1/status": { get: secured },
			"/v1/components": { get: secured },
			"/v1/mode": { get: secured, post: secured },
			"/v1/transitions/{id}": { get: secured },
			"/v1/updates": { get: secured },
			"/v1/updates/{id}": { get: secured },
			"/v1/updates/channel": { get: secured },
			"/v1/updates/check": { post: secured },
			"/v1/updates/plan": { post: secured },
			"/v1/reconcile": { post: secured },
			"/v1/events/stream": { get: secured },
			"/v1/metrics": { get: secured },
		},
	};
}
function components() {
	const manager = ["manager-api", "manager-supervisor"].map((name) => {
		const unit = `treeseed-ai-${name}.service`;
		try {
			return {
				name,
				state: execFileSync("systemctl", ["is-active", unit], {
					encoding: "utf8",
				}).trim(),
			};
		} catch {
			return { name, state: "inactive" };
		}
	});
	const products = setting<unknown>("components", {});
	return [...manager, ...normalizeStoredComponents(products)];
}
function queue(
	kind: "transition" | "update-check" | "update-plan" | "reconcile",
	operation: SupervisorOperation,
	request: unknown,
	idempotencyKey: string,
) {
	const work = createWork(kind, idempotencyKey, request);
	if (work.state === "queued")
		void callSupervisor({
			operation,
			parameters: request as Record<string, unknown>,
			idempotencyKey,
		})
			.then((result) =>
				finishWork(
					work.id,
					(result as { state?: string })?.state === "postponed"
						? "postponed"
						: "succeeded",
					result,
				),
			)
			.catch((error) =>
				finishWork(
					work.id,
					"failed",
					undefined,
					error instanceof Error ? error.message : String(error),
				),
			);
	return work;
}
export function createManagerApp() {
	const app = new Hono();
	app.get("/healthz", (c) => c.json({ status: "ready", version: VERSION }));
	app.get("/readyz", (c) => c.json({ status: "ready", manager: true }));
	app.get("/openapi.json", (c) => c.json(openapi()));
	app.get("/docs", (c) =>
		c.html(
			'<!doctype html><title>TreeAI Manager API</title><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>',
		),
	);
	app.use("/v1/*", apiKeyAuthorization(resolve));
	app.get("/v1/version", requireScope("platform:read"), (c) =>
		c.json({ version: VERSION, api: "1.0" }),
	);
	app.get("/v1/status", requireScope("platform:read"), (c) =>
		c.json({
			status: "ready",
			mode: setting("mode", "awake"),
			updates: updateStatus(),
			components: components(),
		}),
	);
	app.get("/v1/components", requireScope("platform:read"), (c) =>
		c.json({ components: components() }),
	);
	app.get("/v1/mode", requireScope("platform:read"), (c) =>
		c.json({ mode: setting("mode", "awake") }),
	);
	app.post("/v1/mode", requireScope("platform:mode"), async (c) => {
		const body = (await c.req.json()) as {
			mode?: unknown;
			idempotencyKey?: string;
		};
		if (!body.idempotencyKey || !["awake", "sleep"].includes(String(body.mode)))
			return c.json(
				{
					error: {
						code: "invalid_request",
						message: "mode and idempotencyKey are required.",
					},
				},
				400,
			);
		return c.json(
			queue("transition", "mode.set", { mode: body.mode }, body.idempotencyKey),
			202,
		);
	});
	app.get("/v1/transitions/:id", requireScope("platform:read"), (c) => {
		const work = getWork(c.req.param("id"));
		return work
			? c.json(work)
			: c.json(
					{ error: { code: "not_found", message: "Transition not found." } },
					404,
				);
	});
	app.get("/v1/updates", requireScope("platform:read"), (c) =>
		c.json({ status: updateStatus() }),
	);
	app.get("/v1/updates/channel", requireScope("platform:read"), (c) =>
		c.json({ channel: updateStatus().channel }),
	);
	app.get("/v1/updates/:id", requireScope("platform:read"), (c) => {
		const work = getWork(c.req.param("id"));
		return work
			? c.json(work)
			: c.json(
					{
						error: {
							code: "not_found",
							message: "Update operation not found.",
						},
					},
					404,
				);
	});
	for (const [value, kind, operation, scope] of [
		["check", "update-check", "update.check", "platform:update:check"],
		["plan", "update-plan", "update.plan", "platform:update:plan"],
	] as const)
		app.post(`/v1/updates/${value}`, requireScope(scope), async (c) => {
			const body = (await c.req.json().catch(() => ({}))) as {
				idempotencyKey?: string;
			};
			const key = body.idempotencyKey ?? c.req.header("idempotency-key");
			if (!key)
				return c.json(
					{
						error: {
							code: "idempotency_required",
							message: "An idempotency key is required.",
						},
					},
					400,
				);
			return c.json(queue(kind, operation, {}, key), 202);
		});
	app.post("/v1/reconcile", requireScope("platform:reconcile"), async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			idempotencyKey?: string;
		};
		const key = body.idempotencyKey ?? c.req.header("idempotency-key");
		if (!key)
			return c.json(
				{
					error: {
						code: "idempotency_required",
						message: "An idempotency key is required.",
					},
				},
				400,
			);
		return c.json(queue("reconcile", "reconcile", {}, key), 202);
	});
	app.get("/v1/events/stream", requireScope("platform:read"), (c) =>
		streamSSE(c, async (stream) => {
			let cursor = Number(c.req.header("last-event-id") ?? 0);
			while (!stream.closed) {
				const batch = events(cursor);
				if (batch.length)
					for (const item of batch) {
						await stream.writeSSE({
							id: item.id,
							event: item.type,
							data: JSON.stringify(item.data),
						});
						cursor = Number(item.id);
					}
				else await stream.writeSSE({ event: "heartbeat", data: "{}" });
				await stream.sleep(5000);
			}
		}),
	);
	app.get("/v1/metrics", requireScope("platform:read"), (c) => {
		const status = updateStatus(),
			mode = setting("mode", "awake");
		return c.text(
			`# TYPE treeai_catalog_generation gauge\ntreeai_catalog_generation ${status.catalogGeneration}\n# TYPE treeai_known_good_generation gauge\ntreeai_known_good_generation ${status.knownGoodGeneration}\n# TYPE treeai_gpu_mode gauge\ntreeai_gpu_mode{mode="${mode}"} 1\n`,
			200,
			{ "content-type": "text/plain; version=0.0.4" },
		);
	});
	return app;
}
