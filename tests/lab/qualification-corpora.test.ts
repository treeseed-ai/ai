import { mkdtempSync,readFileSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qualificationLibraryInput, readCorpusCatalog, selectFiling,verifiedGenerationCache } from "../../packages/lab/src/corpus.js";

describe("qualification corpus acquisition", () => {
	it("pins a fair-access cross-sector EDGAR and NASA catalog", () => {
		const value = readCorpusCatalog("release/qualification-corpora.json");
		expect(value.financial.maximumRequestsPerSecond).toBeLessThanOrEqual(5);
		expect(value.financial.minimumUsableTokens).toBeGreaterThanOrEqual(500_000);
		expect(value.financial.minimumHeldOutTokens).toBeGreaterThanOrEqual(50_000);
		expect(value.financial.issuers).toHaveLength(12);
		expect(value.multimodal.reports.length).toBeGreaterThanOrEqual(4);
		expect(value.multimodal.reports).toContainEqual(expect.objectContaining({ id: "20240000182", sha256: "11bbe5fc664bd1d1d722ee4fb07cf6fa23fe77d1efc84e658a98d841fde434e9", size: 34_497_958 }));
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
	it('reuses only integrity-checked objects from the same catalog generation',()=>{const root=mkdtempSync(join(tmpdir(),'treeai-corpus-')),path=join(root,'source.json'),body=Buffer.from('immutable'),sha256='3e58bada6a180c0d7f817bdae51fba96a461575b309bfbc17a6918d20c6617c7';writeFileSync(path,body);expect(verifiedGenerationCache(path,{catalogGeneration:10,sha256,size:body.length},10)?.body).toEqual(body);expect(verifiedGenerationCache(path,{catalogGeneration:10,sha256,size:body.length},11)).toBeNull();expect(()=>verifiedGenerationCache(path,{catalogGeneration:10,sha256:'0'.repeat(64),size:body.length},10)).toThrow(/integrity/u);expect(()=>verifiedGenerationCache(join(root,'missing'),{catalogGeneration:10,sha256,size:body.length},10)).toThrow(/missing/u);});
	it("keeps acquisition immutable and does not commit raw corpora", () => {
		const source = readFileSync("packages/lab/src/corpus.ts", "utf8");
		expect(source).toContain("if-none-match");
		expect(source).toContain("changed unexpectedly");
		expect(source).toContain("SEC_USER_AGENT");
		expect(source).not.toContain("Authorization: Bearer");
	});
	it("keeps corpus acquisition scopes fixed and permits NASA without SEC identity",()=>{const source=readFileSync("packages/lab/src/corpus.ts","utf8"),cli=readFileSync("packages/lab/src/cli.ts","utf8");expect(source).toContain('scope:"all"|"financial"|"multimodal"="all"');expect(source).toContain('scope!=="multimodal"');expect(cli).toContain("--scope all|financial|multimodal");});
});
