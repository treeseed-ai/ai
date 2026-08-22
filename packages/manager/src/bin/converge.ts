import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { isIP } from "node:net";
import {
	finalizeConfiguration,
	validatePlatformConfiguration,
	type PlatformConfiguration,
} from "@ai-platform/common";
import { paths } from "../core/paths.js";
import { setSetting } from "../core/store.js";
import { applyUpdate } from "../lifecycle/update.js";
import { ensureOperatorCredential } from "../lifecycle/credentials.js";
import { reconcilePlatform } from "../lifecycle/platform.js";
import {
	assertLegacyServiceEnvironment,
	legacyPlatformConfiguration,
} from "../migration/legacy.js";
const treeai = "/etc/treeseed-ai/treeai",
	seed = "/var/lib/treeseed-ai/bootstrap/seed/platform.json";
function atomic(path: string, value: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode });
	renameSync(temporary, path);
	chmodSync(path, mode);
}
function migrate(): PlatformConfiguration | undefined {
	const old = `${treeai}/config.json`;
	const legacy04 = existsSync(
		"/var/lib/treeseed-ai/bootstrap/legacy-0.4.approved",
	);
	if (!existsSync(old) && !legacy04) return;
	const value = existsSync(old)
		? (JSON.parse(readFileSync(old, "utf8")) as {
				deploymentMode?: string;
			})
		: {};
	if (legacy04) {
		for (const product of ["inference", "training"]) {
			const environment = `/etc/treeseed-ai/${product}/environment`;
			if (!existsSync(environment))
				throw new Error(`Legacy ${product} environment is missing.`);
			assertLegacyServiceEnvironment(
				product,
				readFileSync(environment, "utf8"),
			);
		}
	}
	return legacyPlatformConfiguration({
		legacy04,
		deploymentMode: value.deploymentMode,
		hostname: hostname(),
	});
}
function configuration() {
	const active = existsSync(paths.configuration)
			? validatePlatformConfiguration(
					JSON.parse(readFileSync(paths.configuration, "utf8")),
				)
			: undefined,
		incoming = "/var/lib/treeseed-ai/bootstrap/seed/platform.json.incoming",
		fromIncoming = existsSync(incoming),
		candidate = fromIncoming
			? validatePlatformConfiguration(
					JSON.parse(readFileSync(incoming, "utf8")),
				)
			: existsSync(seed)
				? validatePlatformConfiguration(JSON.parse(readFileSync(seed, "utf8")))
				: migrate();
	if (active && candidate) {
		if (active.configurationId !== candidate.configurationId) return active;
		if (candidate.generation <= active.generation) {
			if (fromIncoming)
				renameSync(incoming, `${incoming}.ignored-${Date.now()}`);
			return active;
		}
	}
	if (active && !candidate) return active;
	if (!candidate)
		throw new Error("No platform seed or migratable configuration exists.");
	const final = finalizeConfiguration(candidate);
	atomic(paths.configuration, JSON.stringify(final, null, 2));
	if (fromIncoming) renameSync(incoming, seed);
	return final;
}
function distribute(record: unknown) {
	atomic(paths.apiKeys, JSON.stringify([record], null, 2), 0o640);
	try {
		execFileSync("chown", ["root:treeseed-ai-manager", paths.apiKeys]);
	} catch {}
	for (const [path, name, group] of [
		[
			"/etc/treeseed-ai/inference/environment",
			"AI_API_KEYS",
			"treeseed-ai-inference",
		],
		[
			"/etc/treeseed-ai/training/environment",
			"AI_API_KEYS",
			"treeseed-ai-training",
		],
		["/etc/treeseed-ai/lab/environment", "AI_LAB_API_KEYS", "treeseed-ai-lab"],
	] as const) {
		if (!existsSync(path)) continue;
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line && !line.startsWith(`${name}=`));
		lines.push(`${name}='${JSON.stringify([record])}'`);
		atomic(path, `${lines.join("\n")}\n`, 0o640);
		try {
			execFileSync("chown", [`root:${group}`, path]);
		} catch {}
	}
}
function safeSans(config: PlatformConfiguration) {
	const values = new Set([
		"localhost",
		"127.0.0.1",
		hostname(),
		...config.network.hostnames,
		...config.network.sans,
	]);
	return [...values]
		.filter(
			(value) =>
				isIP(value) > 0 || /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(value),
		)
		.map((value) => `${isIP(value) > 0 ? "IP" : "DNS"}:${value}`);
}
function tls(config: PlatformConfiguration) {
	const root = "/etc/treeseed-ai/manager/tls",
		publicCa = "/etc/ssl/certs/treeseed-ai-ca.pem";
	if (existsSync(`${root}/server.crt`) && existsSync(`${root}/ca.crt`)) {
		copyFileSync(`${root}/ca.crt`, publicCa);
		chmodSync(publicCa, 0o644);
		chmodSync(`${root}/ca.key`, 0o600);
		chmodSync(`${root}/server.key`, 0o640);
		try {
			execFileSync("chown", [
				"root:treeseed-ai-manager",
				`${root}/server.key`,
				`${root}/server.crt`,
			]);
		} catch {}
		return publicCa;
	}
	mkdirSync(root, { recursive: true, mode: 0o750 });
	execFileSync("openssl", [
		"req",
		"-x509",
		"-newkey",
		"rsa:3072",
		"-nodes",
		"-days",
		"3650",
		"-keyout",
		`${root}/ca.key`,
		"-out",
		`${root}/ca.crt`,
		"-subj",
		"/CN=TreeAI Local CA",
		"-addext",
		"basicConstraints=critical,CA:TRUE",
	]);
	execFileSync("openssl", [
		"req",
		"-newkey",
		"rsa:3072",
		"-nodes",
		"-keyout",
		`${root}/server.key`,
		"-out",
		`${root}/server.csr`,
		"-subj",
		`/CN=${hostname()}`,
	]);
	execFileSync(
		"openssl",
		[
			"x509",
			"-req",
			"-days",
			"825",
			"-in",
			`${root}/server.csr`,
			"-CA",
			`${root}/ca.crt`,
			"-CAkey",
			`${root}/ca.key`,
			"-CAcreateserial",
			"-out",
			`${root}/server.crt`,
			"-extfile",
			"/dev/stdin",
		],
		{
			input: `subjectAltName=${safeSans(config).join(",")}\nextendedKeyUsage=serverAuth\n`,
		},
	);
	chmodSync(`${root}/ca.key`, 0o600);
	chmodSync(`${root}/server.key`, 0o640);
	for (const name of ["ca.crt", "server.crt"])
		chmodSync(`${root}/${name}`, 0o644);
	try {
		execFileSync("chown", [
			"root:treeseed-ai-manager",
			`${root}/server.key`,
			`${root}/server.crt`,
		]);
	} catch {}
	copyFileSync(`${root}/ca.crt`, publicCa);
	chmodSync(publicCa, 0o644);
	return publicCa;
}
function client(config: PlatformConfiguration, ca: string) {
	const host = config.network.hostnames[0] ?? hostname();
	atomic(
		`${treeai}/config.json`,
		JSON.stringify(
			{
				schemaVersion: "treeai.config/v1",
				version: "0.6.1",
				imageSource: config.imageSource,
				ca,
				endpoints: {
					manager: `https://${host}:4790`,
					inference: `https://${host}:4770`,
					openai: `https://${host}:4771`,
					training: `https://${host}:4780`,
					lab: `https://${host}:4793`,
				},
				installedProducts: config.products,
			},
			null,
			2,
		),
		0o644,
	);
}
function migrateFactoryMaterial(config: PlatformConfiguration) {
	if (config.configurationId !== "migrated-local-factory") return;
	const original = "/etc/treeseed-ai/host-runtime/factory",
		backup = "/var/lib/treeseed-ai/bootstrap/legacy/factory-config",
		old = existsSync(original) ? original : backup,
		factory = "/etc/treeseed-ai/manager/factory",
		tlsRoot = "/etc/treeseed-ai/manager/tls";
	mkdirSync(factory, { recursive: true, mode: 0o750 });
	mkdirSync(tlsRoot, { recursive: true, mode: 0o750 });
	for (const name of [
		"artifact-signing-key.pem",
		"artifact-signing-public.pem",
		"training-local-source.json",
		"artifact-import-token",
	])
		if (existsSync(`${old}/${name}`) && !existsSync(`${factory}/${name}`))
			copyFileSync(`${old}/${name}`, `${factory}/${name}`);
	for (const name of ["ca.key", "ca.crt", "server.key", "server.crt"])
		if (existsSync(`${old}/tls/${name}`) && !existsSync(`${tlsRoot}/${name}`))
			copyFileSync(`${old}/tls/${name}`, `${tlsRoot}/${name}`);
	const oldMode = "/var/lib/treeseed-ai/host-runtime/factory/mode.json";
	if (existsSync(oldMode) && !existsSync(paths.mode)) {
		const value = JSON.parse(readFileSync(oldMode, "utf8")) as {
			mode?: string;
		};
		if (value.mode === "awake" || value.mode === "sleep") {
			setSetting("mode", value.mode);
			atomic(
				paths.mode,
				JSON.stringify({
					schemaVersion: "treeai.mode/v1",
					mode: value.mode,
					updatedAt: new Date().toISOString(),
				}),
				0o644,
			);
		}
	}
}
export async function converge() {
	const config = configuration();
	migrateFactoryMaterial(config);
	const credential = ensureOperatorCredential();
	distribute(credential.record);
	const ca = tls(config);
	client(config, ca);
	const temporary =
		"/var/lib/treeseed-ai/bootstrap/seed/temporary-credentials.json";
	if (existsSync(temporary)) {
		atomic(
			"/var/lib/treeseed-ai/bootstrap/seed/consumed.json",
			JSON.stringify({
				consumedAt: new Date().toISOString(),
				temporaryCredentialsRevoked: true,
				temporaryCredentialsActivated: false,
				verification: "absent-from-final-api-records",
				packageMustBeDeleted: true,
			}),
		);
		rmSync(temporary);
		process.stderr.write(
			"The configured installer contained revoked temporary credentials; delete the downloaded .deb.\n",
		);
	}
	const update = await applyUpdate();
	if (update.state === "postponed") return { status: "postponed", update };
	const platform =
		"platform" in update ? update.platform : await reconcilePlatform();
	if (
		platform &&
		config.configurationId === "migrated-local-factory" &&
		(existsSync("/var/lib/treeseed-ai/bootstrap/legacy-0.4.approved") ||
			existsSync("/var/lib/treeseed-ai/bootstrap/legacy-0.4.consumed"))
	)
		atomic(
			"/var/lib/treeseed-ai/manager/legacy-0.4-migration.json",
			JSON.stringify({
				schemaVersion: "treeai.legacy-migration-receipt/v1",
				status: "succeeded",
				completedAt: new Date().toISOString(),
				configurationId: config.configurationId,
				generation: config.generation,
				configurationDigest: config.provenance.configurationDigest,
				mode: platform.mode,
				preservedHashes:
					"/var/lib/treeseed-ai/bootstrap/legacy/preserved.sha256",
			}),
		);
	return {
		status: "ready",
		configurationId: config.configurationId,
		generation: config.generation,
		update,
		platform,
	};
}
if (import.meta.url === `file://${process.argv[1]}`)
	converge()
		.then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
