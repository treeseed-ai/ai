type Runner = (file: string, args: string[]) => string;
type Lab = (args: string[]) => string;
type Recorder = (name: string, details: Record<string, unknown>) => unknown;

function bindingsReady(command: Runner) {
	try {
		const ports = JSON.parse(command("docker", [
			"inspect",
			"--format",
			"{{json .NetworkSettings.Ports}}",
			"treeseed-ai-lab-gateway-1",
		])) as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
		return [["443/tcp", "443"], ["4793/tcp", "4793"]].every(([key, port]) =>
			ports[key!]?.some((binding) => binding.HostIp === "127.0.0.1" && binding.HostPort === port),
		);
	} catch {
		return false;
	}
}

function digest(output: string) {
	return output.trim().split(/\s+/u)[0] ?? "";
}

function gatewayConfigCurrent(command: Runner) {
	try {
		const installed = digest(command("sha256sum", ["/usr/lib/treeseed-ai/lab/Caddyfile"]));
		const mounted = digest(command("docker", [
			"exec",
			"treeseed-ai-lab-gateway-1",
			"sha256sum",
			"/etc/caddy/Caddyfile",
		]));
		return installed.length === 64 && installed === mounted;
	} catch {
		return false;
	}
}

function installManagedAction(lab: Lab, command: Runner, record: Recorder) {
	const environment = JSON.parse(
		command("docker", ["inspect", "--format", "{{json .Config.Env}}", "treeseed-ai-lab-open-webui-1"]),
	) as string[];
	if (!environment.includes("WEBUI_AUTH=false")) return;
	const result = lab(["exec", "-T", "open-webui", "python", "/opt/treeai/actions/install_treeai_action.py"]);
	record("lab.open-webui.action-installed", { action: "treeai_train_library", result });
}

function reloadGateway(lab: Lab, record: Recorder) {
	const config = ["--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
	lab(["exec", "-T", "gateway", "caddy", "validate", ...config]);
	lab(["exec", "-T", "gateway", "caddy", "reload", ...config]);
	record("lab.gateway.configuration-reloaded", { config: "/etc/caddy/Caddyfile" });
}

export function reconcileLabEdge(lab: Lab, command: Runner, record: Recorder) {
	lab(["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "900"]);
	const bindings = bindingsReady(command), configCurrent = gatewayConfigCurrent(command);
	if (!bindings || !configCurrent) {
		record("lab.edge-recreate-required", {
			reason: !bindings ? "effective_bindings_missing" : "managed_config_changed",
		});
		lab(["up", "-d", "--force-recreate", "--no-deps", "gateway"]);
		if (!bindingsReady(command)) throw new Error("Lab gateway effective loopback bindings are missing after recreation.");
		if (!gatewayConfigCurrent(command)) throw new Error("Lab gateway did not mount the installed Caddy configuration.");
	}
	reloadGateway(lab, record);
	installManagedAction(lab, command, record);
}
