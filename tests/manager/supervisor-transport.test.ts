import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSupervisorTransport } from "../../packages/manager/src/lifecycle/supervisor-transport.js";

const servers: Array<ReturnType<typeof createSupervisorTransport>> = [];
const directories: string[] = [];

async function fixture(execute: Parameters<typeof createSupervisorTransport>[0]) {
	const directory = mkdtempSync(join(tmpdir(), "treeai-supervisor-"));
	const socketPath = join(directory, "control.sock");
	const server = createSupervisorTransport(execute);
	servers.push(server);
	directories.push(directory);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return socketPath;
}

function request(socketPath: string, payload: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const client = connect(socketPath);
		let response = "";
		client.setEncoding("utf8");
		client.on("connect", () => client.end(`${payload}\n`));
		client.on("data", (chunk) => { response += chunk; });
		client.on("error", reject);
		client.on("close", () => {
			try { resolve(JSON.parse(response) as Record<string, unknown>); }
			catch (error) { reject(error); }
		});
	});
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("supervisor transport", () => {
	it("repairs the complete runtime path before starting the root supervisor", () => {
		const unit = readFileSync(
			new URL("../../systemd/treeseed-ai-manager-supervisor.service", import.meta.url),
			"utf8",
		);
		expect(unit).toContain(
			"ExecStartPre=/usr/bin/install -d -o root -g root -m 0711 /run/treeseed-ai",
		);
		expect(unit).toContain(
			"ExecStartPre=/usr/bin/install -d -o root -g treeseed-ai-manager -m 0750 /run/treeseed-ai/manager",
		);
	});

	it("responds after a client half-closes its request stream", async () => {
		const socketPath = await fixture(async () => ({ accepted: true }));
		const response = await request(socketPath, JSON.stringify({ operation: "reconcile", idempotencyKey: "one" }));
		expect(response).toEqual({ ok: true, result: { accepted: true } });
	});

	it("runs post-reply effects only after the response is flushed", async () => {
		const effects: string[] = [];
		const directory = mkdtempSync(join(tmpdir(), "treeai-supervisor-"));
		const socketPath = join(directory, "control.sock");
		const server = createSupervisorTransport(
			async () => ({ accepted: true }),
			undefined,
			() => effects.push("after-reply"),
		);
		servers.push(server);
		directories.push(directory);
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		expect(await request(socketPath, JSON.stringify({ operation: "reconcile", idempotencyKey: "effect" }))).toMatchObject({ ok: true });
		expect(effects).toEqual(["after-reply"]);
	});

	it("returns complete JSON for malformed and failed operations", async () => {
		const socketPath = await fixture(async () => { throw new Error("bounded failure"); });
		expect(await request(socketPath, "not-json")).toMatchObject({ ok: false });
		expect(await request(socketPath, JSON.stringify({ operation: "reconcile", idempotencyKey: "two" }))).toEqual({
			ok: false,
			error: { code: "operation_failed", message: "bounded failure" },
		});
	});

	it("survives a disconnected client and serves the next request", async () => {
		const socketPath = await fixture(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { accepted: true };
		});
		await new Promise<void>((resolve, reject) => {
			const client = connect(socketPath, () => {
				client.write(`${JSON.stringify({ operation: "reconcile", idempotencyKey: "gone" })}\n`);
				client.destroy();
				resolve();
			});
			client.on("error", reject);
		});
		expect(await request(socketPath, JSON.stringify({ operation: "reconcile", idempotencyKey: "three" }))).toMatchObject({ ok: true });
	});
});
