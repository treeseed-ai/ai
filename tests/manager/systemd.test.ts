import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
		expect(supervisor).toContain(
			'request.operation === "update.channel.set"',
		);
		expect(supervisor).toMatch(/socket\.end\([\s\S]+activateChannelTimer/u);
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
			"systemctl start --no-block treeseed-ai-manager-update-helper.timer",
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
