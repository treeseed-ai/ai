import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import {
	finalizeConfiguration,
	validatePlatformConfiguration,
	type PlatformConfiguration,
} from "@ai-platform/common";
import { paths } from "../core/paths.js";
import { event } from "../core/store.js";
import { securePlatformConfiguration } from "../core/configuration-file.js";

const labRoot = "/var/lib/treeseed-ai/manager/lab";
const pendingPath = `${labRoot}/open-webui-pending.json`;
const volume = "treeseed-ai-lab_open-webui-data";
const browserUrl = "https://chat.treeai.localhost";

function command(file: string, args: string[]) {
	return execFileSync(file, args, { encoding: "utf8" }).trim();
}

function atomic(path: string, value: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const next = `${path}.new`;
	writeFileSync(next, value, { mode });
	renameSync(next, path);
	chmodSync(path, mode);
}

async function portAvailable() {
	await new Promise<void>((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(443, "127.0.0.1", () => server.close(() => resolve()));
	});
}

function desiredConfiguration() {
	const current = validatePlatformConfiguration(
		JSON.parse(readFileSync(paths.configuration, "utf8")),
	);
	if (!current.products.includes("lab"))
		throw new Error("The lab component is not enabled in platform desired state.");
	const desired = structuredClone(current);
	desired.lab = {
		webui: {
			authentication: "disabled",
			browserUrl,
			binding: "127.0.0.1:443",
		},
	};
	if (!desired.network.sans.includes("chat.treeai.localhost"))
		desired.network.sans.push("chat.treeai.localhost");
	desired.generation += 1;
	desired.provenance.generator = "treeai-lab-local-single-user";
	desired.provenance.generatedAt = new Date().toISOString();
	return { current, desired: finalizeConfiguration(desired) };
}

export async function configureLocalSingleUser() {
	if (existsSync(pendingPath)) {
		const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as {
			desired?: PlatformConfiguration;
		};
		if (pending.desired)
			validatePlatformConfiguration(pending.desired);
		return {
			status: "ready",
			changed: false,
			resetRequired: true,
			browserUrl,
		};
	}
	const { current, desired } = desiredConfiguration();
	if (
		current.lab?.webui.authentication === "disabled" &&
		current.lab.webui.browserUrl === browserUrl &&
		current.lab.webui.binding === "127.0.0.1:443"
	)
		return { status: "ready", changed: false, resetRequired: false, browserUrl };
	try {
		await portAvailable();
	} catch {
		throw new Error(
			"127.0.0.1:443 is already in use; stop or reconfigure that listener before enabling local Open WebUI.",
		);
	}
	atomic(
		pendingPath,
		`${JSON.stringify(
			{
				schemaVersion: "treeai.lab-webui-change/v1",
				createdAt: new Date().toISOString(),
				previous: current,
				desired,
			},
			null,
			2,
		)}\n`,
	);
	event("lab.webui.configuration-staged", {
		generation: desired.generation,
		browserUrl,
	});
	return { status: "ready", changed: true, resetRequired: true, browserUrl };
}

function compose(args: string[], allowFailure = false) {
	const result = spawnSync(
		"docker",
		[
			"compose",
			"-p",
			"treeseed-ai-lab",
			"--env-file",
			"/etc/treeseed-ai/lab/environment",
			"-f",
			"/usr/lib/treeseed-ai/lab/compose.yml",
			...args,
		],
		{ encoding: "utf8", timeout: 900_000 },
	);
	if (!allowFailure && result.status !== 0)
		throw new Error(
			`Lab Compose failed: ${(result.stderr || result.stdout).trim()}`,
		);
	return result;
}

function reconcile() {
	command("systemctl", ["start", "treeseed-ai-manager-reconcile.service"]);
}

function volumeMountpoint() {
	return command("docker", ["volume", "inspect", volume, "--format", "{{.Mountpoint}}"]);
}

function createVolume() {
	command("docker", [
		"volume",
		"create",
		"--label",
		"com.docker.compose.project=treeseed-ai-lab",
		"--label",
		"com.docker.compose.volume=open-webui-data",
		volume,
	]);
}

export function assertWebUiAuthenticationDisabled(configuration: unknown) {
	if (
		typeof configuration !== "object" ||
		configuration === null ||
		!("features" in configuration) ||
		typeof configuration.features !== "object" ||
		configuration.features === null ||
		!("auth" in configuration.features) ||
		configuration.features.auth !== false
	)
		throw new Error("Open WebUI still reports authentication enabled.");
}

function validateLocalWebUi() {
	command("curl", [
		"--silent",
		"--show-error",
		"--fail",
		"--retry",
		"20",
		"--retry-delay",
		"1",
		"--cacert",
		"/etc/ssl/certs/treeseed-ai-ca.pem",
		`${browserUrl}/health`,
	]);
	const configuration: unknown = JSON.parse(
		command("curl", [
			"--silent",
			"--show-error",
			"--fail",
			"--cacert",
			"/etc/ssl/certs/treeseed-ai-ca.pem",
			`${browserUrl}/api/config`,
		]),
	);
	assertWebUiAuthenticationDisabled(configuration);
	const models = compose([
		"exec",
		"-T",
		"experience-proxy",
		"node",
		"-e",
		"fetch('http://127.0.0.1:8080/v1/models',{headers:{authorization:'Bearer lab-open-webui'}}).then(async r=>{if(!r.ok)throw new Error(await r.text());const v=await r.json();if(!Array.isArray(v.data)||!v.data.length)throw new Error('No models')})",
	]);
	void models;
	const published = command("docker", [
		"port",
		"treeseed-ai-lab-gateway-1",
		"443/tcp",
	]);
	if (!published.split("\n").includes("127.0.0.1:443"))
		throw new Error("Open WebUI gateway is not restricted to 127.0.0.1:443.");
	const inspect = command("docker", ["inspect", "treeseed-ai-lab-open-webui-1"]),
		upstreamKey = readFileSync(
			"/etc/treeseed-ai/lab/secrets/factory-inference-key",
			"utf8",
		).trim();
	if (inspect.includes(upstreamKey))
		throw new Error("The upstream inference credential leaked into Open WebUI metadata.");
}

function restoreVolume(archive: string) {
	compose(["stop", "gateway", "open-webui"], true);
	compose(["rm", "-f", "-s", "gateway", "open-webui"], true);
	spawnSync("docker", ["volume", "rm", "-f", volume], { encoding: "utf8" });
	createVolume();
	command("tar", ["-xzf", archive, "-C", volumeMountpoint()]);
}

export function resetOpenWebUi(confirm: boolean) {
	if (!confirm) throw new Error("reset-webui requires --confirm.");
	if (!existsSync(pendingPath))
		throw new Error(
			"No local single-user configuration is staged; run treeai lab configure --local-single-user first.",
		);
	const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as {
		previous: PlatformConfiguration;
		desired: PlatformConfiguration;
	};
	validatePlatformConfiguration(pending.desired);
	const backupRoot = "/var/lib/treeseed-ai/lab/backups",
		stamp = new Date().toISOString().replace(/[:.]/gu, "-"),
		archive = `${backupRoot}/open-webui-${stamp}.tar.gz`,
		receipt = `${backupRoot}/open-webui-${stamp}.json`,
		prior = readFileSync(paths.configuration, "utf8");
	mkdirSync(backupRoot, { recursive: true, mode: 0o750 });
	compose(["stop", "gateway", "open-webui"], true);
	compose(["rm", "-f", "-s", "gateway", "open-webui"], true);
	if (spawnSync("docker", ["volume", "inspect", volume]).status === 0)
		command("tar", ["-czf", archive, "-C", volumeMountpoint(), "."]);
	else {
		createVolume();
		command("tar", ["-czf", archive, "-C", volumeMountpoint(), "."]);
	}
	const checksum = command("sha256sum", [archive]).split(/\s+/u)[0]!;
	try {
		command("docker", ["volume", "rm", volume]);
		createVolume();
		atomic(paths.configuration, `${JSON.stringify(pending.desired, null, 2)}\n`, 0o640);
		securePlatformConfiguration();
		reconcile();
		validateLocalWebUi();
		atomic(
			receipt,
			`${JSON.stringify(
				{
					schemaVersion: "treeai.lab-webui-reset/v1",
					status: "succeeded",
					completedAt: new Date().toISOString(),
					archive,
					checksum: `sha256:${checksum}`,
					volume,
					browserUrl,
				},
				null,
				2,
			)}\n`,
			0o640,
		);
		renameSync(pendingPath, `${pendingPath}.consumed-${stamp}`);
		event("lab.webui.reset-completed", { archive, checksum, browserUrl });
		return { status: "ready", browserUrl, archive, receipt };
	} catch (error) {
		atomic(paths.configuration, prior, 0o640);
		securePlatformConfiguration();
		restoreVolume(archive);
		try {
			reconcile();
		} catch {}
		event("lab.webui.reset-rolled-back", {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
