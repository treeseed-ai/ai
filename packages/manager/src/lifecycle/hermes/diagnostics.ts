import { execFileSync } from "node:child_process";
import { redactSensitiveText } from "@ai-platform/common";

const container = "treeseed-ai-lab-hermes-agent-1";
const edgeContainers = {
	gateway: "treeseed-ai-lab-gateway-1",
	controller: "treeseed-ai-lab-controller-1",
};

function docker(args: string[]) {
	return execFileSync("docker", args, {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 256 * 1024,
	});
}

function sanitized(value: string) {
	return redactSensitiveText(value)
		.replace(/\/run\/secrets\/[A-Za-z0-9._-]+/gu, "/run/secrets/[REDACTED]")
		.replace(/\/home\/[A-Za-z0-9._-]+/gu, "/home/[REDACTED]");
}

function privateRuntimeEvidence() {
	const script = [
		"import json, pathlib",
		"root=pathlib.Path('/home/hermes/.hermes')",
		"paths=['gateway_state.json','logs/gateway.log','logs/errors.log','logs/agent.log']",
		"result={}",
		"for name in paths:",
		" p=root/name",
		" if p.is_file(): result[name]='\\n'.join(p.read_text(errors='replace').splitlines()[-80:])[-65536:]",
		"print(json.dumps(result))",
	].join("\n");
	try {
		return JSON.parse(docker(["exec", container, "python", "-c", script])) as Record<string, string>;
	} catch (error) {
		const value = error as { stdout?: string; stderr?: string };
		return { diagnosticError: `${value.stdout ?? ""}${value.stderr ?? ""}` };
	}
}

function edgeEvidence() {
	return Object.fromEntries(Object.entries(edgeContainers).map(([role, name]) => {
		try {
			const parts = docker([
				"inspect",
				"--format",
				"{{json .State}}|{{json .NetworkSettings.Ports}}|{{json .HostConfig.PortBindings}}",
				name,
			]).trim().split("|").map((part) => JSON.parse(part || "null"));
			const [state, ports, bindings] = parts;
			return [role, { state, ports, bindings }];
		} catch (error) {
			return [role, { error: sanitized(error instanceof Error ? error.message : String(error)) }];
		}
	}));
}

function edgeLogs() {
	try {
		return docker(["logs", "--tail", "80", edgeContainers.gateway]);
	} catch (error) {
		const value = error as { stdout?: string; stderr?: string };
		return `${value.stdout ?? ""}${value.stderr ?? ""}`;
	}
}

export function hermesDiagnostics() {
	const state = JSON.parse(
		docker(["inspect", "--format", "{{json .State}}", container]),
	) as {
		Status?: string;
		Running?: boolean;
		Restarting?: boolean;
		ExitCode?: number;
		Health?: { Status?: string; FailingStreak?: number };
	};
	let logs = "";
	try {
		logs = docker(["logs", "--tail", "80", container]);
	} catch (error) {
		const value = error as { stdout?: string; stderr?: string };
		logs = `${value.stdout ?? ""}${value.stderr ?? ""}`;
	}
	return {
		status: state.Running && state.Health?.Status === "healthy" ? "ready" : "warning",
		container: {
			state: state.Status ?? "unknown",
			running: state.Running === true,
			restarting: state.Restarting === true,
			exitCode: state.ExitCode ?? null,
			health: state.Health?.Status ?? "none",
			failingStreak: state.Health?.FailingStreak ?? 0,
		},
		logs: sanitized(logs).split("\n").filter(Boolean),
		edge: edgeEvidence(),
		gatewayLogs: sanitized(edgeLogs()).split("\n").filter(Boolean),
		privateRuntime: Object.fromEntries(
			Object.entries(privateRuntimeEvidence()).map(([name, value]) => [
				name,
				sanitized(value).split("\n").filter(Boolean),
			]),
		),
	};
}
