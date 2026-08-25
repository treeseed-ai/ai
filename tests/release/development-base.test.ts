import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectDevelopmentBase, type GithubReleaseSummary } from "../../scripts/release/select-development-base.js";

const release = (tagName: string, isPrerelease = false, isDraft = false): GithubReleaseSummary => ({ tagName, isPrerelease, isDraft });

describe("development image baseline selection", () => {
  it("selects the highest prior RC in the same release line", () => {
    expect(selectDevelopmentBase("0.10.0-rc6", [release("0.9.0"), release("0.10.0-rc2", true), release("0.10.0-rc5", true), release("0.11.0-rc1", true)]))
      .toBe("0.10.0-rc5");
  });

  it("falls back to the latest listed stable release for the first RC", () => {
    expect(selectDevelopmentBase("0.10.0-rc1", [release("0.9.0"), release("0.8.0")])).toBe("0.9.0");
  });

  it("ignores drafts and later candidates", () => {
    expect(selectDevelopmentBase("0.10.0-rc5", [release("0.10.0-rc6", true), release("0.10.0-rc4", true, true), release("0.9.0")])).toBe("0.9.0");
  });

  it("rejects malformed targets and missing baselines", () => {
    expect(() => selectDevelopmentBase("v0.10.0-rc2", [release("0.9.0")])).toThrow("Invalid release-candidate tag");
    expect(() => selectDevelopmentBase("0.10.0-rc2", [])).toThrow("No prior RC or stable release");
  });

  it("requires checksum verification before planning from the selected manifest", () => {
    const workflow = readFileSync(".github/workflows/publish-development.yml", "utf8");
    expect(workflow).toContain("select-development-base.ts");
    expect(workflow).toContain('gh release download "$previous" --pattern image-manifest.json --pattern SHA256SUMS');
    expect(workflow).toContain('test "$actual" = "$expected"');
  });
});
