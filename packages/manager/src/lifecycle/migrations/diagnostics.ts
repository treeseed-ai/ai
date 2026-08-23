import { spawnSync } from "node:child_process";
import { redactSensitiveText } from "@ai-platform/common";

type Product = "inference" | "training";
type ComposeProduct = { compose: string; overlay: string; environment: string };

export function migrationDiagnostics(product: Product, item: ComposeProduct) {
	const result = spawnSync("docker", [
		"compose", "-p", `treeseed-ai-${product}`,
		"--env-file", item.environment,
		"-f", item.compose,
		"-f", item.overlay,
		"logs", "--no-color", "--tail", "80", "migrations",
	], { encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
	return redactSensitiveText(`${result.stdout ?? ""}${result.stderr ?? ""}`)
		.replace(/\/run\/secrets\/[A-Za-z0-9._-]+/gu, "/run/secrets/[REDACTED]")
		.trim()
		.slice(-65_536);
}
