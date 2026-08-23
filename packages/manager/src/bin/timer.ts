import { readFileSync } from "node:fs";
import { validatePlatformConfiguration } from "@ai-platform/common";
import { paths } from "../core/paths.js";
import { applyUpdate, checkForUpdate } from "../lifecycle/update.js";
import { event, setSetting, setting } from "../core/store.js";
function inWindow(weekday: string, time: string) {
	const now = new Date(),
		days = [
			"sunday",
			"monday",
			"tuesday",
			"wednesday",
			"thursday",
			"friday",
			"saturday",
		],
		[hour, minute] = time.split(":").map(Number);
	return (
		days[now.getDay()] === weekday &&
		now.getHours() === hour &&
		now.getMinutes() >= minute! &&
		now.getMinutes() < minute! + 30
	);
}
async function run() {
	const config = validatePlatformConfiguration(
			JSON.parse(readFileSync(paths.configuration, "utf8")),
		),
		retry = setting<{ failures: number; nextAttempt: string | null; scope?: "metadata" | "apply" }>("retry", {
			failures: 0,
			nextAttempt: null,
		});
	if (retry.scope === "metadata" && retry.nextAttempt && Date.parse(retry.nextAttempt) > Date.now()) return;
	setSetting("timerPhase", "metadata");
	const candidate = checkForUpdate();
	if (candidate.changed) {
		setSetting("stagedGeneration", candidate.generation);
		setSetting("retry", { failures: 0, nextAttempt: null, scope: "apply" });
	} else if (retry.scope !== "metadata" && retry.nextAttempt && Date.parse(retry.nextAttempt) > Date.now()) return;
	const staged = setting<number | null>("stagedGeneration", null),
		shouldApply =
			staged !== null &&
			((config.updates.channel === "development" &&
				config.updates.policy === "continuous") ||
				(config.updates.channel === "stable" &&
					config.updates.policy === "scheduled" &&
					inWindow(
						config.updates.maintenanceWindow.weekday,
						config.updates.maintenanceWindow.localTime,
					)));
	if (shouldApply) {
		setSetting("timerPhase", "apply");
		setSetting("automaticInvocation", true);
		try {
			const result = await applyUpdate();
			event("timer.apply", result);
		} finally {
			setSetting("automaticInvocation", false);
		}
	}
	setSetting("retry", { failures: 0, nextAttempt: null, scope: "apply" });
	setSetting("timerPhase", "idle");
}
run().catch((error) => {
	const prior = setting<{ failures: number }>("retry", { failures: 0 }),
		failures = prior.failures + 1,
		seconds = Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6)),
		scope = setting<"metadata" | "apply">("timerPhase", "metadata");
	setSetting("retry", {
		failures,
		nextAttempt: new Date(Date.now() + seconds * 1000).toISOString(),
		scope,
	});
	event("timer.failure", {
		failures,
		scope,
		error: error instanceof Error ? error.message : String(error),
	});
	console.error(`TreeAI update failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
