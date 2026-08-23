import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
	finalizeConfiguration,
	validatePlatformConfiguration,
} from "@ai-platform/common";
import {
	applyUpdate,
	activateChannelTimer,
	checkForUpdate,
	planUpdate,
	restoreGeneration,
	setChannel,
} from "./update.js";
import { event, setSetting, setting } from "../core/store.js";
import { paths } from "../core/paths.js";
import { securePlatformConfiguration } from "../core/configuration-file.js";
import { supervisorOperations, type SupervisorRequest } from "./socket.js";
import { createSupervisorTransport } from "./supervisor-transport.js";
import { rotateOperatorCredential } from "./credentials.js";
import {
	reconcilePlatform,
	stopManagedProduct,
	transitionMode,
} from "./platform.js";
import {
	configureLocalSingleUser,
	resetOpenWebUi,
} from "./lab-webui.js";
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
	securePlatformConfiguration();
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
	securePlatformConfiguration();
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
		case "lab.webui.configure":
			return configureLocalSingleUser();
		case "lab.webui.reset":
			return resetOpenWebUi(parameters.confirm === true);
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
	const server = createSupervisorTransport(
		execute,
		(error) =>
			event("supervisor.socket-error", {
				code: error.name,
				message: error.message,
			}),
		(request) => {
			if (request.operation !== "update.channel.set") return;
			try {
				activateChannelTimer(request.parameters?.channel);
			} catch (error) {
				event("update.timer-activation-failed", {
					channel: request.parameters?.channel,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	);
	server.listen(paths.socket, () => chmodSync(paths.socket, 0o660));
	return server;
}
