import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
	finalizeConfiguration,
	validatePlatformConfiguration,
} from "@ai-platform/common";
import {
	applyUpdate,
	checkForUpdate,
	planUpdate,
	restoreGeneration,
	setChannel,
} from "./update.js";
import { event, setSetting, setting } from "../core/store.js";
import { paths } from "../core/paths.js";
import { supervisorOperations, type SupervisorRequest } from "./socket.js";
import { rotateOperatorCredential } from "./credentials.js";
import {
	reconcilePlatform,
	stopManagedProduct,
	transitionMode,
} from "./platform.js";
function rootOnly() {
	if (process.getuid?.() !== 0)
		throw new Error("Manager supervisor must run as root.");
}
function atomic(path: string, value: unknown, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const temporary = `${path}.new`;
	writeFileSync(temporary, JSON.stringify(value, null, 2), { mode });
	renameSync(temporary, path);
}
function adopt(parameters: Record<string, unknown> = {}) {
	const path = parameters.path;
	if (
		typeof path !== "string" ||
		![
			"/var/lib/treeseed-ai/bootstrap/seed/platform.json",
			"/var/lib/treeseed-ai/bootstrap/seed/platform.json.incoming",
		].includes(path)
	)
		throw new Error("Only a packaged seed path may be adopted.");
	const candidate = validatePlatformConfiguration(
			JSON.parse(readFileSync(path, "utf8")),
		),
		current = existsSync(paths.configuration)
			? validatePlatformConfiguration(
					JSON.parse(readFileSync(paths.configuration, "utf8")),
				)
			: undefined;
	if (
		current &&
		current.configurationId !== candidate.configurationId &&
		!parameters.confirm
	)
		throw new Error(
			"Different configurationId requires explicit confirmation.",
		);
	if (
		current &&
		candidate.configurationId === current.configurationId &&
		candidate.generation <= current.generation
	)
		return { changed: false, generation: current.generation };
	atomic(paths.configuration, finalizeConfiguration(candidate));
	event("config.adopted", {
		configurationId: candidate.configurationId,
		generation: candidate.generation,
	});
	return { changed: true, generation: candidate.generation };
}
function component(value: unknown, enabled: boolean) {
	if (value !== "inference" && value !== "training" && value !== "lab")
		throw new Error("Component is not allowlisted.");
	const config = validatePlatformConfiguration(
			JSON.parse(readFileSync(paths.configuration, "utf8")),
		),
		products = new Set(config.products);
	if (enabled) products.add(value);
	else products.delete(value);
	if (
		products.has("lab") &&
		(!products.has("inference") || !products.has("training"))
	)
		throw new Error("Disable lab before disabling inference or training.");
	config.products = [...products] as typeof config.products;
	config.generation += 1;
	config.provenance.generator = "treeai-manager-component";
	atomic(paths.configuration, finalizeConfiguration(config));
	event("component.desired-state", {
		component: value,
		enabled,
		generation: config.generation,
	});
	return config;
}
export async function execute(request: SupervisorRequest) {
	rootOnly();
	if (!supervisorOperations.includes(request.operation))
		throw new Error("Operation is not allowlisted.");
	const parameters = request.parameters ?? {};
	switch (request.operation) {
		case "auth.rotate":
			return rotateOperatorCredential();
		case "update.check":
			return checkForUpdate();
		case "update.plan":
			return planUpdate();
		case "update.apply":
			return applyUpdate();
		case "update.cancel-before-install":
			if (setting("installStarted", false))
				throw new Error(
					"Cancellation is unavailable after dpkg installation starts.",
				);
			setSetting("updateCancelled", true);
			return { cancelled: true };
		case "update.channel.set":
			return setChannel(
				parameters.channel,
				parameters.approveDowngrade === true,
			);
		case "update.pause":
			setSetting("updatesPaused", true);
			return { paused: true };
		case "update.resume":
			setSetting("updatesPaused", false);
			return { paused: false };
		case "config.validate":
			return validatePlatformConfiguration(
				JSON.parse(readFileSync(paths.configuration, "utf8")),
			);
		case "config.adopt":
			return adopt(parameters);
		case "component.enable": {
			component(parameters.component, true);
			return applyUpdate();
		}
		case "component.disable":
			component(parameters.component, false);
			return stopManagedProduct(parameters.component);
		case "mode.set": {
			const config = validatePlatformConfiguration(
				JSON.parse(readFileSync(paths.configuration, "utf8")),
			);
			return transitionMode(parameters.mode, config.updates.drain);
		}
		case "reconcile":
			return reconcilePlatform();
		case "recovery.retry":
			execFileSync("systemctl", [
				"start",
				"treeseed-ai-manager-update.service",
			]);
			return { accepted: true };
		case "recovery.restore-generation":
			return restoreGeneration(parameters.generation);
	}
}
export function startSupervisor() {
	rootOnly();
	mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o750 });
	rmSync(paths.socket, { force: true });
	const server = createServer((socket) => {
		let input = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			input += chunk;
			if (input.length > 65536) socket.destroy(new Error("Request too large."));
		});
		socket.on("end", async () => {
			try {
				const request = JSON.parse(input.trim()) as SupervisorRequest;
				if (!request.idempotencyKey)
					throw new Error("idempotencyKey is required.");
				const result = await execute(request);
				socket.end(`${JSON.stringify({ ok: true, result })}\n`);
			} catch (error) {
				socket.end(
					`${JSON.stringify({ ok: false, error: { code: "operation_failed", message: error instanceof Error ? error.message : String(error) } })}\n`,
				);
			}
		});
	});
	server.listen(paths.socket, () => chmodSync(paths.socket, 0o660));
	return server;
}
