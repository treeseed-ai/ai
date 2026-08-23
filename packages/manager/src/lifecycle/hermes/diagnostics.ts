import { execFileSync } from "node:child_process";
import { redactSensitiveText } from "@ai-platform/common";

const container = "treeseed-ai-lab-hermes-agent-1";

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
	};
}
