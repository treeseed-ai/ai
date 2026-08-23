import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("independent product architecture", () => {
	it("has no TreeSeed SDK or control-plane coupling", () => {
		const metadata = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
		expect(JSON.stringify(metadata)).not.toContain("@treeseed/sdk");
		const sources = ["packages/common", "packages/host-runtime", "packages/inference-api", "packages/inference-manager", "packages/training-api", "packages/training-manager"]
			.map((path) => readFileSync(resolve(path, "package.json"), "utf8"))
			.join("\n");
		expect(sources).not.toMatch(/capacity-provider|treedx|assignment|settlement|@treeseed\/sdk/i);
	});

	it("provides two independent migrations and deployments", () => {
		for (const product of ["inference", "training"]) {
			expect(readFileSync(resolve(`migrations/${product}/001_initial.sql`), "utf8")).toContain("CREATE TABLE IF NOT EXISTS jobs");
			expect(readFileSync(resolve(`deploy/${product}/compose.yml`), "utf8")).toContain(`name: treeseed-ai-${product}`);
		}
	});

	it("runs every product migration once with checksum history", () => {
		execFileSync("sh", ["-n", "containers/migrations/run.sh"]);
		const runner = readFileSync("containers/migrations/run.sh", "utf8");
		expect(runner).toContain("treeai_schema_migrations");
		expect(runner).toContain("sha256sum");
		expect(runner).toContain("/migrations/*.sql");
		expect(runner).toContain("pg_advisory_xact_lock");
		for (const product of ["inference", "training"]) {
			const dockerfile = readFileSync(`containers/${product}/migrations.Dockerfile`, "utf8");
			expect(dockerfile).toContain("treeai-run-migrations");
			expect(dockerfile).toContain(`TREEAI_MIGRATION_PRODUCT=${product}`);
			expect(dockerfile).not.toContain("/migrations/001_initial.sql");
		}
	});
});
