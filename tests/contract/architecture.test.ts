import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("independent product architecture", () => {
	it("uses the SDK only for portable deployment and AI mode contracts", () => {
		const metadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
		expect(metadata.devDependencies["@treeseed/sdk"]).toBe("0.13.0-rc.108");
		const sources = ["packages/inference-api", "packages/inference-manager", "packages/training-api", "packages/training-manager"]
			.map((path) => readFileSync(resolve(path, "package.json"), "utf8"))
			.join("\n");
		expect(sources).not.toMatch(/capacity-provider|treedx|assignment|settlement/i);
		expect(readFileSync(resolve("scripts/release/create-component-release.ts"), "utf8")).toContain("@treeseed/sdk/deployment");
		expect(readFileSync(resolve("packages/lab/src/mode-control.ts"), "utf8")).toContain("@treeseed/sdk/deployment");
	});

	it("provides two independent migrations and deployments", () => {
		for (const product of ["inference", "training"]) {
			expect(readFileSync(resolve(`migrations/${product}/001_initial.sql`), "utf8")).toContain("CREATE TABLE IF NOT EXISTS jobs");
			expect(readFileSync(resolve("deploy/component/compose.template.yml"), "utf8")).toContain(`${product}-migrations:`);
		}
	});

	it("runs every product migration once with checksum history", () => {
		const runner = readFileSync("packages/common/src/database/migrations.ts", "utf8");
		expect(runner).toContain("treeai_schema_migrations");
		expect(runner).toContain("createHash('sha256')");
		expect(runner).toContain("session.query(file.sql)");
		expect(runner).toContain("SELECT checksum FROM treeai_schema_migrations WHERE product=$1 AND version=$2");
		expect(runner).toContain("session.query('ROLLBACK')");
		for (const product of ["inference", "training"]) {
			const dockerfile = readFileSync(`containers/${product}/migrations.Dockerfile`, "utf8");
			expect(dockerfile).toContain("treeai-run-migrations");
			expect(dockerfile).toContain(`TREEAI_MIGRATION_PRODUCT=${product}`);
			expect(dockerfile).not.toContain("/migrations/001_initial.sql");
		}
	});
});
