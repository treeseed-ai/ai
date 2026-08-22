import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("manager scheduling and privilege split", () => {
	it("polls development every 60 seconds with jitter", () => {
		const timer = readFileSync(
			"systemd/treeseed-ai-manager-development.timer",
			"utf8",
		);
		expect(timer).toContain("OnUnitInactiveSec=60s");
		expect(timer).toContain("RandomizedDelaySec=5s");
		expect(timer).toContain("Persistent=true");
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

	it("revokes configured-seed material before public reconciliation", () => {
		const converge = readFileSync(
			"packages/manager/src/bin/converge.ts",
			"utf8",
		);
		const revoke = converge.indexOf("temporaryCredentialsActivated: false");
		const apply = converge.indexOf("const update = await applyUpdate()");
		expect(revoke).toBeGreaterThan(0);
		expect(revoke).toBeLessThan(apply);
	});

	it("packages the canonical schema and migration helper", () => {
		const packaging = readFileSync("scripts/package-deb.ts", "utf8");
		expect(packaging).toContain("platform.schema.json");
		expect(packaging).toContain("migrate-0.4.sh");
	});
});
