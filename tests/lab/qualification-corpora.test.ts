import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualificationLibraryInput, readCorpusCatalog, selectFiling } from "../../packages/lab/src/corpus.js";

describe("qualification corpus acquisition", () => {
	it("pins a fair-access cross-sector EDGAR and NASA catalog", () => {
		const value = readCorpusCatalog("release/qualification-corpora.json");
		expect(value.financial.maximumRequestsPerSecond).toBeLessThanOrEqual(5);
		expect(value.financial.minimumUsableTokens).toBeGreaterThanOrEqual(500_000);
		expect(value.financial.minimumHeldOutTokens).toBeGreaterThanOrEqual(50_000);
		expect(value.financial.issuers).toHaveLength(12);
		expect(value.multimodal.reports.length).toBeGreaterThanOrEqual(3);
		for (const report of value.multimodal.reports) {
			expect(report.url).toMatch(/^https:\/\/ntrs\.nasa\.gov\//u);
			expect(report.sha256).toMatch(/^[a-f0-9]{64}$/u);
		}
	});
	it("selects the latest 10-K before a 10-Q fallback", () => {
		const recent = { form: ["8-K", "10-Q", "10-K"], accessionNumber: ["a", "q", "k"], primaryDocument: ["a.htm", "q.htm", "k.htm"], filingDate: ["1", "2", "3"] };
		expect(selectFiling(recent)).toMatchObject({ form: "10-K", accession: "k" });
		expect(selectFiling({ ...recent, form: ["8-K", "10-Q"] })).toMatchObject({ form: "10-Q", accession: "q" });
	});
	it("uses the current training API library contract", () => {
		expect(qualificationLibraryInput("TreeAI EDGAR Qualification", "qualification-edgar")).toEqual({ sourceKind: "api", externalId: "qualification-edgar", slug: "qualification-edgar", name: "TreeAI EDGAR Qualification", description: "Non-production qualification corpus" });
	});
	it("keeps acquisition immutable and does not commit raw corpora", () => {
		const source = readFileSync("packages/lab/src/corpus.ts", "utf8");
		expect(source).toContain("if-none-match");
		expect(source).toContain("changed unexpectedly");
		expect(source).toContain("SEC_USER_AGENT");
		expect(source).not.toContain("Authorization: Bearer");
	});
});
