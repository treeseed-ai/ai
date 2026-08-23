import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import type { PlatformConfiguration } from "@ai-platform/common";

// Certificates are staged and validated before any managed gateway consumes them.

export function writeServerExtensions(stage: string, requiredSans: string[]) {
	const path = `${stage}/server-extensions.cnf`;
	writeFileSync(
		path,
		`subjectAltName=${requiredSans.join(",")}\nextendedKeyUsage=serverAuth\n`,
		{ mode: 0o600 },
	);
	chmodSync(path, 0o600);
	return path;
}

export function requiredServerSans(config: PlatformConfiguration) {
	const webuiHost = config.lab?.webui.browserUrl
			? new URL(config.lab.webui.browserUrl).hostname
			: undefined,
		hermesHost = config.lab?.hermes?.dashboardUrl
			? new URL(config.lab.hermes.dashboardUrl).hostname
			: config.products.includes("lab")
				? "hermes.treeai.localhost"
				: undefined;
	return [
		...new Set([
			"localhost",
			"127.0.0.1",
			hostname(),
			...config.network.hostnames,
			...config.network.sans,
			...(webuiHost ? [webuiHost] : []),
			...(hermesHost ? [hermesHost] : []),
		]),
	]
		.filter(
			(value) =>
				isIP(value) > 0 || /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(value),
		)
		.map((value) => `${isIP(value) > 0 ? "IP" : "DNS"}:${value}`);
}

export function ensurePlatformTls(config: PlatformConfiguration) {
	const root = "/etc/treeseed-ai/manager/tls",
		publicCa = "/etc/ssl/certs/treeseed-ai-ca.pem",
		requiredSans = requiredServerSans(config),
		serverKey = `${root}/server.key`,
		serverCertificate = `${root}/server.crt`;
	mkdirSync(root, { recursive: true, mode: 0o750 });
	if (!existsSync(`${root}/ca.crt`))
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650",
			"-keyout", `${root}/ca.key`, "-out", `${root}/ca.crt`,
			"-subj", "/CN=TreeAI Local CA", "-addext", "basicConstraints=critical,CA:TRUE",
		]);
	if (!existsSync(`${root}/ca.key`))
		throw new Error(
			"The existing TreeAI CA private key is unavailable; the server certificate cannot be extended transactionally.",
		);
	const supports =
		existsSync(serverCertificate) &&
		requiredSans.every((entry) => {
			const [type, value] = entry.split(":", 2);
			return spawnSync(
				"openssl",
				["x509", "-in", serverCertificate, "-noout", type === "IP" ? "-checkip" : "-checkhost", value!],
				{ encoding: "utf8" },
			).status === 0;
		});
	if (supports) {
		copyFileSync(`${root}/ca.crt`, publicCa);
		chmodSync(publicCa, 0o644);
		chmodSync(`${root}/ca.key`, 0o600);
		chmodSync(serverKey, 0o640);
		return { ca: publicCa, changed: false, commit() {}, rollback() {} };
	}
	const stage = mkdtempSync(`${root}/server-stage-`),
		stagedKey = `${stage}/server.key`,
		stagedCertificate = `${stage}/server.crt`,
		extensions = writeServerExtensions(stage, requiredSans),
		backupKey = `${root}/server.key.previous`,
		backupCertificate = `${root}/server.crt.previous`;
	execFileSync("openssl", [
		"req", "-newkey", "rsa:3072", "-nodes", "-keyout", stagedKey,
		"-out", `${stage}/server.csr`, "-subj", `/CN=${hostname()}`,
	]);
	execFileSync("openssl", [
		"x509", "-req", "-days", "825", "-in", `${stage}/server.csr`,
		"-CA", `${root}/ca.crt`, "-CAkey", `${root}/ca.key`, "-CAcreateserial",
		"-out", stagedCertificate, "-extfile", extensions,
	]);
	execFileSync("openssl", ["verify", "-CAfile", `${root}/ca.crt`, stagedCertificate]);
	for (const entry of requiredSans) {
		const [type, value] = entry.split(":", 2);
		execFileSync("openssl", [
			"x509", "-in", stagedCertificate, "-noout",
			type === "IP" ? "-checkip" : "-checkhost", value!,
		]);
	}
	if (existsSync(serverKey)) copyFileSync(serverKey, backupKey);
	if (existsSync(serverCertificate)) copyFileSync(serverCertificate, backupCertificate);
	renameSync(stagedKey, serverKey);
	renameSync(stagedCertificate, serverCertificate);
	chmodSync(`${root}/ca.key`, 0o600);
	chmodSync(serverKey, 0o640);
	for (const name of ["ca.crt", "server.crt"]) chmodSync(`${root}/${name}`, 0o644);
	try {
		execFileSync("chown", ["root:treeseed-ai-manager", serverKey, serverCertificate]);
	} catch {}
	copyFileSync(`${root}/ca.crt`, publicCa);
	chmodSync(publicCa, 0o644);
	return {
		ca: publicCa,
		changed: true,
		commit() {
			rmSync(backupKey, { force: true });
			rmSync(backupCertificate, { force: true });
			rmSync(stage, { recursive: true, force: true });
		},
		rollback() {
			if (existsSync(backupKey)) renameSync(backupKey, serverKey);
			else rmSync(serverKey, { force: true });
			if (existsSync(backupCertificate)) renameSync(backupCertificate, serverCertificate);
			else rmSync(serverCertificate, { force: true });
			rmSync(stage, { recursive: true, force: true });
		},
	};
}
