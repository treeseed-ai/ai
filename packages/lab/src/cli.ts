#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { redactSensitiveText, transportFailure } from "@ai-platform/common";

const command = process.argv[2];
const args = process.argv.slice(3);
const root = "/etc/treeseed-ai/lab";
const envFile = `${root}/environment`;
const composeFile = "/usr/lib/treeseed-ai/lab/compose.yml";
const composePortsFile = "/etc/treeseed-ai/lab/ports.override.yml";
const json = args.includes("--json");

interface ClientConfiguration {
	ca: string;
	imageSource?: string;
	deploymentMode?: string;
	endpoints: Record<string, string>;
	interfaces?: {
		openWebUi?: {
			authentication: "disabled" | "local-users";
			browserUrl: string;
			binding: string;
		};
		hermes?: {
			authentication: "local-password";
			dashboardUrl: string;
			binding: string;
		};
	};
}

function run(file: string, values: string[], stdio: "pipe" | "inherit" = "pipe", cwd?: string) {
	const result = execFileSync(file, values, { encoding: "utf8", stdio, cwd });
	return typeof result === "string" ? result.trim() : "";
}
function output(value: unknown) {
	process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
}
function option(name: string) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}
function requireRoot(operation: string) {
	if (process.getuid?.() !== 0) throw new Error(`${operation} requires root.`);
}
function operator() {
	return process.env.TREEAI_OPERATOR_KEY_VALUE ?? readFileSync("/etc/treeseed-ai/treeai/operator.key", "utf8").trim();
}
function client() {
	return JSON.parse(readFileSync("/etc/treeseed-ai/treeai/config.json", "utf8")) as ClientConfiguration;
}
function call(path: string, method = "GET") {
	const config = client();
	const values = ["--silent", "--show-error", "--fail-with-body", "--cacert", config.ca, "-H", `Authorization: Bearer ${operator()}`, "-H", "content-type: application/json", "-X", method];
	if (method === "POST") values.push("-H", `Idempotency-Key: treeai-${path}-${Date.now()}`);
	const target = `${config.endpoints.lab}${path}`;
	values.push(target);
	try {
		return JSON.parse(run("curl", values)) as unknown;
	} catch (error) {
		throw transportFailure(error, target);
	}
}
function supervisor(operation: "lab.webui.configure" | "lab.webui.reset" | "lab.hermes.password.rotate", parameters?: Record<string, unknown>) {
	requireRoot(operation);
	return new Promise<unknown>((resolveRequest, reject) => {
		const socket = connect("/run/treeseed-ai/manager/control.sock");
		let response = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.end(`${JSON.stringify({ operation, parameters, idempotencyKey: crypto.randomUUID() })}\n`));
		socket.on("data", (chunk) => { response += chunk; });
		socket.on("error", reject);
		socket.on("close", () => {
			try {
				const value = JSON.parse(response) as { ok: boolean; result?: unknown; error?: { message: string } };
				if (value.ok) resolveRequest(value.result);
				else reject(new Error(value.error?.message ?? "Supervisor rejected the operation."));
			} catch (error) { reject(error); }
		});
	});
}
function compose(values: string[], stdio: "pipe" | "inherit" = "inherit") {
	return run("docker", ["compose", "-p", "treeseed-ai-lab", "--env-file", envFile, "-f", composeFile, "-f", composePortsFile, ...values], stdio);
}
function urls() {
	const settings = client(), webui = settings.interfaces?.openWebUi, hermes = settings.interfaces?.hermes;
	const interfaces = [
		...(webui ? [{ id: "open-webui", url: webui.browserUrl, binding: webui.binding, authentication: webui.authentication, certificateAuthority: settings.ca }] : []),
		...(hermes ? [{ id: "hermes", url: hermes.dashboardUrl, binding: hermes.binding, authentication: hermes.authentication, certificateAuthority: settings.ca }] : []),
	];
	return {
		status: webui && hermes ? "ready" : "warning",
		interfaces,
	};
}
function verify(deep = false) {
	const controller = call("/v1/status"), settings = client(), webui = settings.interfaces?.openWebUi;
	if (!webui) return { status: "warning", controller, openWebUi: "not-configured" };
	const health = run("curl", ["--silent", "--show-error", "--fail", "--cacert", settings.ca, `${webui.browserUrl}/health`]);
	const providerModels = JSON.parse(run("curl", ["--silent", "--show-error", "--fail", "--cacert", settings.ca, `${webui.browserUrl}/api/models`])) as unknown;
	const serialized = JSON.stringify(providerModels);
	if (!serialized.includes("hermes-agent")) throw new Error("Open WebUI model discovery does not include hermes-agent.");
	for (const port of [4792, 8642]) {
		const probe = spawnSync("curl", ["--silent", "--fail", "--max-time", "1", `http://127.0.0.1:${port}/`]);
		if (probe.status === 0) throw new Error(`Private Hermes port ${port} is unexpectedly reachable from the host.`);
	}
	return { status: "ready", controller, isolation: { hostPortsClosed: [4792, 8642] }, openWebUi: { url: webui.browserUrl, authentication: webui.authentication, health: health || "ok", models: providerModels }, hermes: call("/v1/hermes/status"), ...(deep ? { deep: call("/v1/hermes/verify", "POST") } : {}) };
}
function imageReference(id: string) {
	const catalog = JSON.parse(readFileSync("/usr/share/treeseed-ai/release/catalog.json", "utf8")) as { runtimeImages: Array<{ id: string; reference: string }> };
	const image = catalog.runtimeImages.find((item) => item.id === id);
	if (!image) throw new Error(`Runtime image ${id} is absent from the release catalog.`);
	return image.reference;
}

async function main() {
	if (command === "plan") {
		const checks = [["package", existsSync(composeFile)], ["factory-ca", existsSync("/etc/ssl/certs/treeseed-ai-ca.pem")], ["operator", existsSync("/etc/treeseed-ai/treeai/operator-record.json")], ["environment", existsSync(envFile)], ["network", run("docker", ["network", "inspect", "ai-shared", "--format", "{{.Driver}}"])]] as Array<[string, boolean | string]>;
		return output({ status: checks.every(([, ok]) => ok === true || ok === "bridge") ? "ready" : "blocked", checks: checks.map(([id, ok]) => ({ id, status: ok === true || ok === "bridge" ? "ready" : "blocked" })) });
	}
	if (command === "configure") {
		if (!args.includes("--local-single-user")) throw new Error("Usage: treeai lab configure --local-single-user");
		return output(await supervisor("lab.webui.configure"));
	}
	if (command === "reset-webui") return output(await supervisor("lab.webui.reset", { confirm: args.includes("--confirm") }));
	if (command === "urls") return output(urls());
	if (command === "open") {
		const targets = args.filter((item) => !item.startsWith("--"));
		if (targets.length !== 1 || !["webui", "hermes"].includes(targets[0]!)) throw new Error("Usage: treeai lab open webui|hermes");
		const interfaces = client().interfaces, target = targets[0] === "webui" ? interfaces?.openWebUi?.browserUrl : interfaces?.hermes?.dashboardUrl;
		if (!target) throw new Error(`${targets[0]} is not configured.`);
		if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && existsSync("/usr/bin/xdg-open")) { const child = spawn("/usr/bin/xdg-open", [target], { stdio: "ignore", detached: true }); child.on("error", () => {}); child.unref(); }
		return output({ status: "ready", url: target });
	}
	if (command === "hermes") {
		const action = args.find((item) => !item.startsWith("--"));
		if (action === "status") return output(call("/v1/hermes/status"));
		if (action === "tools") return output(call("/v1/hermes/tools"));
		if (action === "sessions") return output(call("/v1/hermes/sessions"));
		if (action === "verify") return output({ status: "ready", statusCheck: call("/v1/hermes/status"), capabilities: call("/v1/hermes/capabilities"), tools: call("/v1/hermes/tools") });
		if (action === "rotate-password") return output(await supervisor("lab.hermes.password.rotate"));
		throw new Error("Usage: treeai lab hermes <status|tools|sessions|verify|rotate-password>");
	}
	if (command === "build") {
		requireRoot("build");
		const settings = client();
		if ((settings.imageSource ?? settings.deploymentMode) !== "local-build" && settings.deploymentMode !== "development") throw new Error("lab build requires local-build image source.");
		const source = resolve(option("--source") ?? process.cwd());
		run("docker", ["buildx", "bake", "--file", "deploy/lab/docker-bake.hcl", "--load"], "inherit", source);
		run("docker", ["pull", imageReference("open-webui")], "inherit");
		return output({ status: "ready", source });
	}
	if (command === "start" || command === "restart") {
		requireRoot(command);
		if (!existsSync(envFile)) throw new Error("Lab configuration is missing.");
		if (command === "restart") compose(["down"]);
		compose(["up", "-d", "--wait"]);
		run("systemctl", ["enable", "treeseed-ai-lab.service"]);
		return output({ status: "ready" });
	}
	if (command === "stop") { requireRoot("stop"); compose(["down"]); return output({ status: "ready" }); }
	if (command === "status") return output(call("/v1/status"));
	if (command === "verify") return output(verify(args.includes("--deep")));
	if (["enable", "pause", "resume"].includes(command ?? "")) return output(call(`/v1/loop/${command}`, "POST"));
	if (command === "cycle-now") return output(call("/v1/loop/cycle-now", "POST"));
	if (command === "watch") {
		const settings = client(), child = spawn("curl", ["--no-buffer", "--cacert", settings.ca, "-H", `Authorization: Bearer ${operator()}`, `${settings.endpoints.lab}/v1/events/stream`], { stdio: "inherit" });
		await new Promise((resolveExit) => child.on("exit", resolveExit));
		return;
	}
	if (command === "logs") {
		requireRoot("logs");
		const allowed = ["controller", "experience-proxy", "open-webui", "hermes-agent", "hermes-dashboard", "web-tool-proxy", "gateway"], service = args.find((item) => !item.startsWith("--"));
		if (service && !allowed.includes(service)) throw new Error("Unsupported lab service.");
		compose(["logs", "--follow", ...(service ? [service] : [])]);
		return;
	}
	throw new Error("Usage: treeai lab <plan|configure|reset-webui|urls|open|hermes|build|start|stop|restart|status|verify|watch|logs|enable|pause|resume|cycle-now>");
}

main().catch((error) => {
	const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
	if (json) output({ error: { code: "lab_error", message } });
	else process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
