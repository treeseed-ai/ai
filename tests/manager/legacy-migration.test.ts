import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	assertLegacyServiceEnvironment,
	legacyPlatformConfiguration,
} from "../../packages/manager/src/migration/legacy.js";

function file(root: string, path: string, value: string, mode = 0o644) {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, value, { mode });
	return target;
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "treeai-migrate-04-"));
	file(root, "usr/lib/systemd/system/treeseed-ai-factory.service", "[Service]\n");
	for (const product of ["inference", "training"])
		file(
			root,
			`etc/treeseed-ai/${product}/environment`,
			"POSTGRES_PASSWORD=db\nS3_SECRET_KEY=s3\nMINIO_ROOT_PASSWORD=minio\n",
			0o640,
		);
	file(
		root,
		"var/lib/treeseed-ai/host-runtime/factory/mode.json",
		'{"mode":"awake"}\n',
		0o600,
	);
	for (const name of ["ca.key", "ca.crt", "server.key", "server.crt"])
		file(
			root,
			`etc/treeseed-ai/host-runtime/factory/tls/${name}`,
			`${name}\n`,
			name.endsWith(".key") ? 0o600 : 0o644,
		);
	for (const name of ["artifact-signing-key.pem", "artifact-signing-public.pem"])
		file(
			root,
			`etc/treeseed-ai/host-runtime/factory/${name}`,
			`${name}\n`,
			name.includes("public") ? 0o644 : 0o600,
		);
	const dpkg = file(root, "bin/dpkg-query", "#!/bin/sh\nprintf '0.4.0'\n", 0o755);
	const log = join(root, "systemctl.log");
	const systemctl = file(
		root,
		"bin/systemctl",
		`#!/bin/sh\nprintf '%s\\n' "$*" >>'${log}'\nexit 0\n`,
		0o755,
	);
	chmodSync(dpkg, 0o755);
	chmodSync(systemctl, 0o755);
	return { root, dpkg, systemctl, log };
}
function run(
	fixture: ReturnType<typeof fixture>,
	args: string[],
) {
	return spawnSync("/bin/sh", ["scripts/bootstrap/migrate-0.4.sh", ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			TREEAI_MIGRATION_ROOT: fixture.root,
			TREEAI_MIGRATION_DPKG_QUERY: fixture.dpkg,
			TREEAI_MIGRATION_SYSTEMCTL: fixture.systemctl,
			TREEAI_MIGRATION_TEST: "true",
		},
	});
}

describe("explicit TreeAI 0.4 migration", () => {
	it("generates a registry-backed, manually gated first convergence", () => {
		const config = legacyPlatformConfiguration({
			legacy04: true,
			hostname: "dev2",
			generatedAt: "2026-08-22T00:00:00.000Z",
		});
		expect(config).toMatchObject({
			configurationId: "migrated-local-factory",
			imageSource: "registry",
			updates: { channel: "stable", policy: "manual" },
			network: { bindings: { manager: "0.0.0.0:4790", lab: "0.0.0.0:4793" } },
		});
		expect(config.provenance.generator).toBe("treeai-migrate-0.4/0.10.0");
		expect(() =>
			assertLegacyServiceEnvironment(
				"inference",
				"POSTGRES_PASSWORD=db\nS3_SECRET_KEY=s3\n",
			),
		).toThrow(/MINIO_ROOT_PASSWORD/u);
	});
	it("plans without mutation and applies only with confirmation", () => {
		const value = fixture();
		try {
			const planned = run(value, ["plan", "--json"]);
			expect(planned.status).toBe(0);
			expect(JSON.parse(planned.stdout)).toMatchObject({
				status: "ready",
				installedVersion: "0.4.0",
				mode: "awake",
				activeWork: false,
			});
			expect(
				existsSync(
					join(value.root, "var/lib/treeseed-ai/bootstrap/legacy-0.4.approved"),
				),
			).toBe(false);
			expect(run(value, ["apply"]).status).toBe(64);
			expect(run(value, ["apply", "--confirm"]).status).toBe(0);
			expect(
				JSON.parse(
					readFileSync(
						join(
							value.root,
							"var/lib/treeseed-ai/bootstrap/legacy-0.4.approved",
						),
						"utf8",
					),
				).schemaVersion,
			).toBe("treeai.legacy-migration-approval/v1");
			expect(readFileSync(value.log, "utf8")).toContain(
				"start --no-block treeseed-ai-bootstrap.service",
			);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("blocks while legacy work is active", () => {
		const value = fixture();
		try {
			file(
				value.root,
				"run/treeseed-ai/inference/status.json",
				'{"active":1}\n',
			);
			const result = run(value, ["plan", "--json"]);
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({
				status: "blocked",
				activeWork: true,
			});
			expect(run(value, ["apply", "--confirm"]).status).toBe(1);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("blocks when legacy cryptographic identity cannot be preserved", () => {
		const value = fixture();
		try {
			rmSync(
				join(
					value.root,
					"etc/treeseed-ai/host-runtime/factory/artifact-signing-key.pem",
				),
			);
			const result = run(value, ["plan", "--json"]);
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked" });
			expect(result.stdout).toContain("artifact-signing-key.pem");
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("stops legacy ownership before dpkg and preserves recovery evidence", () => {
		const bootstrap = readFileSync("scripts/bootstrap/bootstrap.sh", "utf8");
		expect(bootstrap).toContain("legacy-0.4.approved");
		expect(bootstrap).toContain("preserved.sha256");
		expect(bootstrap.indexOf("systemctl disable --now treeseed-ai-factory.service")).toBeLessThan(
			bootstrap.indexOf("apt-get -o DPkg::Lock::Timeout=600 --no-remove"),
		);
		expect(bootstrap).toContain("refusing unsafe legacy restart");
	});
});
