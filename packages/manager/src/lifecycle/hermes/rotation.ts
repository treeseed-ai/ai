import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hashHermesPassword } from "./password.js";
import { event } from "../../core/store.js";

const secretPath = "/etc/treeseed-ai/lab/secrets/hermes-password-hash";
const compose = [
	"compose",
	"-p",
	"treeseed-ai-lab",
	"--env-file",
	"/etc/treeseed-ai/lab/environment",
	"-f",
	"/usr/lib/treeseed-ai/lab/compose.yml",
	"-f",
	"/etc/treeseed-ai/lab/ports.override.yml",
];

function replaceHash(value: string) {
	const next = `${secretPath}.new`;
	writeFileSync(next, `${value}\n`, { mode: 0o640 });
	execFileSync("chown", ["root:treeseed-ai-lab", next]);
	renameSync(next, secretPath);
	chmodSync(secretPath, 0o640);
}

function restartDashboard() {
	execFileSync("docker", [
		...compose,
		"up",
		"-d",
		"--no-deps",
		"--force-recreate",
		"--wait",
		"hermes-dashboard",
	], { stdio: "pipe", timeout: 180_000 });
}

export function rotateHermesPassword() {
	const previous = readFileSync(secretPath, "utf8").trim(),
		password = randomBytes(24).toString("base64url");
	try {
		replaceHash(hashHermesPassword(password));
		restartDashboard();
		event("lab.hermes.password-rotated", { rotatedAt: new Date().toISOString() });
		return {
			status: "ready",
			password,
			warning: "This password is shown once and is not stored in plaintext.",
		};
	} catch (error) {
		replaceHash(previous);
		try { restartDashboard(); } catch {}
		event("lab.hermes.password-rotation-rolled-back", {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
