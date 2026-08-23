import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	reconcileConfiguredPlatform,
	writeServerExtensions,
} from "../../packages/manager/src/bin/converge.js";
import { requiredServerSans } from "../../packages/manager/src/lifecycle/certificates/tls.js";

describe("manager scheduling and privilege split", () => {
	it("polls development every 60 seconds with jitter", () => {
		const timer = readFileSync(
			"systemd/treeseed-ai-manager-development.timer",
			"utf8",
		);
		expect(timer).toContain("OnUnitInactiveSec=60s");
		expect(timer).toContain("OnActiveSec=60s");
		expect(timer).toContain("RandomizedDelaySec=5s");
		expect(timer).toContain("Persistent=true");
	});

	it("delays channel timer activation until after the supervisor reply", () => {
		const supervisor = readFileSync(
			"packages/manager/src/lifecycle/supervisor.ts",
			"utf8",
		);
		const update = readFileSync(
			"packages/manager/src/lifecycle/update.ts",
			"utf8",
		);
		expect(supervisor).toMatch(
			/request\.operation\s+!={1,2}\s+"update\.channel\.set"/u,
		);
		const transport = readFileSync(
			"packages/manager/src/lifecycle/supervisor-transport.ts",
			"utf8",
		);
		expect(transport).toMatch(/socket\.end\([\s\S]+afterReply/u);
		expect(supervisor).toMatch(/createSupervisorTransport\([\s\S]+activateChannelTimer/u);
		expect(update).toContain('"enable",');
		expect(update).not.toMatch(
			/name === channel \? "enable" : "disable", "--now"/u,
		);
	});

	it("suppresses only the private Node SQLite experimental warning", () => {
		const cli = readFileSync("packages/cli/src/main.ts", "utf8");
		expect(cli).toContain("--disable-warning=ExperimentalWarning");
		for (const name of ["api", "supervisor", "update", "reconcile"]) {
			const unit = readFileSync(
				`systemd/treeseed-ai-manager-${name}.service`,
				"utf8",
			);
			expect(unit).toContain("--disable-warning=ExperimentalWarning");
			expect(unit).not.toContain("NODE_NO_WARNINGS");
		}
	});

	it("writes TLS SAN extensions without relying on systemd stdin", () => {
		const stage = mkdtempSync(join(tmpdir(), "treeai-tls-"));
		try {
			const path = writeServerExtensions(stage, [
				"DNS:chat.treeai.localhost",
				"IP:127.0.0.1",
			]);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(readFileSync(path, "utf8")).toBe(
				"subjectAltName=DNS:chat.treeai.localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
			);
			expect(
				readFileSync("packages/manager/src/bin/converge.ts", "utf8"),
			).not.toContain('"/dev/stdin"');
		} finally {
			rmSync(stage, { recursive: true, force: true });
		}
	});

	it("issues manager TLS for the fixed Docker host alias", () => {
		const config = JSON.parse(readFileSync("config/platform.default.json", "utf8"));
		expect(requiredServerSans(config)).toContain("DNS:host.docker.internal");
	});

	it("reconciles desired state after a package-only update", async () => {
		const reconciled = { mode: "awake", services: { lab: "ready" } };
		const reconcile = vi.fn(async () => reconciled);
		expect(await reconcileConfiguredPlatform(undefined, reconcile)).toBe(
			reconciled,
		);
		expect(reconcile).toHaveBeenCalledOnce();

		const alreadyReconciled = { mode: "sleep", services: {} };
		reconcile.mockClear();
		expect(
			await reconcileConfiguredPlatform(alreadyReconciled, reconcile),
		).toBe(alreadyReconciled);
		expect(reconcile).not.toHaveBeenCalled();
	});

	it("runs the API unprivileged and supervisor without a listener", () => {
		const api = readFileSync(
			"systemd/treeseed-ai-manager-api.service",
			"utf8",
		);
		const supervisor = readFileSync(
			"systemd/treeseed-ai-manager-supervisor.service",
			"utf8",
		);
		expect(api).toContain("User=treeseed-ai-manager");
		expect(supervisor).toContain("User=root");
		expect(supervisor).not.toMatch(/ListenStream|TREEAI_MANAGER_PORT/u);
	});

	it("keeps bootstrap postinst asynchronous except for explicit legacy approval", () => {
		const postinst = readFileSync("debian/bootstrap/postinst", "utf8");
		expect(postinst).not.toContain("apt-get");
		expect(postinst).toContain("start --no-block");
		expect(postinst).toContain("treeseed-ai-manager-update.service");
		expect(postinst).toContain("active|activating|reloading");
		expect(postinst).toContain("migrate-0.4.sh apply --confirm");
		expect(readFileSync("scripts/bootstrap/bootstrap.sh", "utf8")).toContain(
			"DPkg::Lock::Timeout=600",
		);
	});

	it("places the bootstrap start limit in the Unit section", () => {
		const unit = readFileSync(
			"systemd/treeseed-ai-bootstrap.service",
			"utf8",
		);
		const [unitSection, serviceSection] = unit.split("[Service]");
		expect(unitSection).toContain("StartLimitIntervalSec=0");
		expect(serviceSection).not.toContain("StartLimitIntervalSec");
	});

	it("repairs manager-readable state permissions during upgrades", () => {
		const bootstrap = readFileSync("debian/bootstrap/postinst", "utf8");
		const manager = readFileSync("debian/manager/postinst", "utf8");
		const converge = readFileSync(
			"packages/manager/src/bin/converge.ts",
			"utf8",
		);
		const store = readFileSync("packages/manager/src/core/store.ts", "utf8");
		expect(bootstrap).toContain("-m 0711 /etc/treeseed-ai");
		expect(manager).toContain(
			"chown root:treeseed-ai-manager /etc/treeseed-ai/platform.json",
		);
		expect(manager).toContain("-name 'lifecycle.db*'");
		expect(converge).toContain("securePlatformConfiguration();");
		expect(store).toContain("if (!existed) chmodSync");
	});

	it("hands an active manager to newly installed code after dpkg exits", () => {
		const postinst = readFileSync("debian/manager/postinst", "utf8");
		const timer = readFileSync(
			"systemd/treeseed-ai-manager-update-helper.timer",
			"utf8",
		);
		expect(postinst).toContain(
			"systemctl is-active --quiet treeseed-ai-manager-api.service",
		);
		expect(postinst).toContain(
			"systemctl restart --no-block treeseed-ai-manager-update-helper.timer",
		);
		expect(timer).toContain("OnActiveSec=30s");
		expect(timer).toContain("treeseed-ai-manager-update-helper.service");
	});

	it("revokes configured-seed material before public reconciliation", () => {
		const converge = readFileSync(
			"packages/manager/src/bin/converge.ts",
			"utf8",
		);
		const revoke = converge.indexOf("temporaryCredentialsActivated: false");
		const apply = converge.indexOf("update = await applyUpdate()");
		expect(revoke).toBeGreaterThan(0);
		expect(revoke).toBeLessThan(apply);
	});

	it("packages the canonical schema and migration helper", () => {
		const packaging = readFileSync("scripts/package-deb.ts", "utf8");
		expect(packaging).toContain("platform.schema.json");
		expect(packaging).toContain("migrate-0.4.sh");
	});
});
