import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { paths } from "./paths.js";

export function securePlatformConfiguration() {
	chmodSync(paths.configuration, 0o640);
	execFileSync("chown", [
		"root:treeseed-ai-manager",
		paths.configuration,
	]);
}
