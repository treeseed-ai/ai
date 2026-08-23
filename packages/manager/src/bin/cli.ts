#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { redactSensitiveText, transportFailure } from "@ai-platform/common";
import { callSupervisor, type SupervisorOperation } from "../lifecycle/socket.js";
import { paths } from "../core/paths.js";
import { buildLocalImages, planLocalBuild } from "../lifecycle/local-build.js";
const [group, command, ...args] = process.argv.slice(2),
	json = args.includes("--json");
function settings() {
	try {
		return JSON.parse(readFileSync(process.env.TREEAI_CONFIG ?? "/etc/treeseed-ai/treeai/config.json", "utf8")) as { ca: string; endpoints: Record<string, string> };
	} catch {
		return { ca: "/etc/treeseed-ai/manager/tls/server.crt", endpoints: { manager: `https://${hostname()}:4790` } };
	}
}
function key() {
	return process.env.TREEAI_OPERATOR_KEY_VALUE ?? readFileSync(process.env.TREEAI_OPERATOR_KEY ?? "/etc/treeseed-ai/treeai/operator.key", "utf8").trim();
}
function api(path: string, method = "GET", body?: unknown) {
	const config = settings(),
		values = ["--silent", "--show-error", "--fail-with-body", "--cacert", config.ca, "-H", `Authorization: Bearer ${key()}`, "-H", "content-type: application/json", "-X", method];
	if (body) values.push("--data", JSON.stringify(body));
	const target = `${config.endpoints.manager ?? config.endpoints.factory}${path}`;
	values.push(target);
	try {
		return JSON.parse(execFileSync("curl", values, { encoding: "utf8" })) as unknown;
	} catch (error) {
		throw transportFailure(error, target);
	}
}
function root() {
	if (process.getuid?.() !== 0) throw new Error("This operation requires local root authority.");
}
function option(name: string) {
	const index = args.indexOf(name);
	return index < 0 ? undefined : args[index + 1];
}
async function local(operation: SupervisorOperation, parameters?: Record<string, unknown>) {
	root();
	return callSupervisor({ operation, parameters, idempotencyKey: crypto.randomUUID() });
}
async function stream() {
	const config = settings(),
		child = spawn("curl", ["--no-buffer", "--silent", "--show-error", "--cacert", config.ca, "-H", `Authorization: Bearer ${key()}`, `${config.endpoints.manager ?? config.endpoints.factory}/v1/events/stream`], { stdio: "inherit" });
	await new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code) => (code ? reject(new Error(`Event stream exited with ${code}.`)) : resolve()));
	});
}
async function platform() {
	if (command === "status") return api("/v1/status");
	if (command === "doctor") return api("/readyz");
	if (command === "components") {
		const action = args.find((item) => item === "enable" || item === "disable"),
			component = action ? args[args.indexOf(action) + 1] : undefined;
		if (action) return local(`component.${action}`, { component });
		return api("/v1/components");
	}
	if (command === "reconcile") return api("/v1/reconcile", "POST", { idempotencyKey: crypto.randomUUID() });
	if (command === "events") return stream();
	if (command === "metrics") {
		const config = settings();
		return execFileSync("curl", ["--silent", "--show-error", "--fail-with-body", "--cacert", config.ca, "-H", `Authorization: Bearer ${key()}`, `${config.endpoints.manager ?? config.endpoints.factory}/v1/metrics`], { encoding: "utf8" });
	}
	throw new Error("Unknown platform command.");
}
async function update() {
	if (command === "check" || command === "plan") return api(`/v1/updates/${command}`, "POST", { idempotencyKey: crypto.randomUUID() });
	if (command === "status" || command === "history") return api("/v1/updates");
	if (command === "apply") return local("update.apply");
	if (command === "channel") return local("update.channel.set", { channel: args.find((item) => item === "stable" || item === "development"), approveDowngrade: args.includes("--approve-downgrade") });
	if (command === "pause" || command === "resume") return local(`update.${command}`);
	if (command === "watch") return stream();
	if (command === "pin" || command === "unpin") throw new Error("Generation pinning requires a cataloged installed generation.");
	throw new Error("Unknown update command.");
}
async function localBuild() {
	root();
	const requested = option("--source");
	if (!requested) throw new Error("--source is required.");
	if (command === "plan") return planLocalBuild(requested);
	if (command === "build") return buildLocalImages(requested);
	if (command === "upgrade") throw new Error("Use local-build build; the staged update continues after its receipt is verified.");
	throw new Error("Unknown local-build command.");
}
async function main() {
	let result: unknown;
	if (group === "auth") {
		if (command !== "rotate") throw new Error("Unknown auth command.");
		result = await local("auth.rotate");
	} else if (group === "platform") result = await platform();
	else if (group === "update") result = await update();
	else if (group === "mode") {
		if (!command) result = api("/v1/mode");
		else if (command === "awake" || command === "sleep") result = api("/v1/mode", "POST", { mode: command, idempotencyKey: crypto.randomUUID() });
		else throw new Error("Mode must be awake or sleep.");
	} else if (group === "config") {
		if (command === "show") result = JSON.parse(readFileSync(paths.configuration, "utf8"));
		else if (command === "validate") result = await local("config.validate");
		else if (command === "adopt") result = await local("config.adopt", { path: option("--seed") ?? "/var/lib/treeseed-ai/bootstrap/seed/platform.json.incoming", confirm: args.includes("--confirm") });
		else throw new Error("Unknown config command.");
	} else if (group === "local-build") result = await localBuild();
	else if (group === "recovery") {
		if (command === "status") result = api("/v1/status");
		else if (command === "retry") result = await local("recovery.retry");
		else if (command === "restore") result = await local("recovery.restore-generation", { generation: Number(option("--generation")) });
		else throw new Error("Unknown recovery command.");
	} else throw new Error("Unsupported manager command group.");
	process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, json ? 2 : 0)}\n`);
}
main().catch((error) => {
	const value = { error: { code: "treeai_manager_error", message: redactSensitiveText(error instanceof Error ? error.message : String(error)) } };
	process.stderr.write(`${json ? JSON.stringify(value) : value.error.message}\n`);
	process.exitCode = 1;
});
