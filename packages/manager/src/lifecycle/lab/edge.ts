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

function installManagedAction(lab: Lab, command: Runner, record: Recorder) {
	const environment = JSON.parse(
		command("docker", ["inspect", "--format", "{{json .Config.Env}}", "treeseed-ai-lab-open-webui-1"]),
	) as string[];
	if (!environment.includes("WEBUI_AUTH=false")) return;
	const result = lab(["exec", "-T", "open-webui", "python", "/opt/treeai/actions/install_treeai_action.py"]);
	record("lab.open-webui.action-installed", { action: "treeai_train_library", result });
}

export function reconcileLabEdge(lab: Lab, command: Runner, record: Recorder) {
	lab(["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "900"]);
	installManagedAction(lab, command, record);
	if (bindingsReady(command)) return;
	record("lab.edge-recreate-required", { reason: "effective_bindings_missing" });
	lab(["up", "-d", "--force-recreate", "--no-deps", "gateway"]);
	if (!bindingsReady(command)) throw new Error("Lab gateway effective loopback bindings are missing after recreation.");
}
