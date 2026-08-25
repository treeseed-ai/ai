import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface GithubReleaseSummary {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

export function selectDevelopmentBase(target: string, releases: GithubReleaseSummary[]): string {
  const match = /^(\d+\.\d+\.\d+)-rc([1-9]\d*)$/u.exec(target);
  if (!match) throw new Error(`Invalid release-candidate tag: ${target}`);
  const [, line, targetNumberText] = match;
  const targetNumber = Number(targetNumberText);
  const candidates = releases
    .filter((release) => !release.isDraft && release.isPrerelease)
    .map((release) => ({ release, match: new RegExp(`^${line.replaceAll(".", "\\.")}-rc([1-9]\\d*)$`, "u").exec(release.tagName) }))
    .filter((item): item is { release: GithubReleaseSummary; match: RegExpExecArray } => Boolean(item.match))
    .map((item) => ({ tag: item.release.tagName, number: Number(item.match[1]) }))
    .filter((item) => item.number < targetNumber)
    .sort((left, right) => right.number - left.number);
  if (candidates[0]) return candidates[0].tag;
  const stable = releases.find((release) => !release.isDraft && !release.isPrerelease);
  if (!stable) throw new Error(`No prior RC or stable release is available for ${target}.`);
  return stable.tagName;
}

function main(): void {
  const target = process.argv[2];
  const source = process.argv[3];
  if (!target || !source) throw new Error("Usage: select-development-base <target-rc> <releases.json>");
  const releases = JSON.parse(readFileSync(source, "utf8")) as GithubReleaseSummary[];
  process.stdout.write(`${selectDevelopmentBase(target, releases)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
