#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const action = process.argv[2];
if (!new Set(["open", "close", "status"]).has(action)) {
	process.stderr.write("Usage: treeseed-ai-gpu-gate open|close|status\n");
	process.exit(2);
}

const gatePath = process.env.TREESEED_GPU_ADMISSION_FILE ?? "/run/treeseed-ai/gate.json";
const activityPath = process.env.TREESEED_GPU_ACTIVITY_FILE ?? "/run/treeseed-ai/status.json";
const fallback = process.env.TREESEED_GPU_DEFAULT_ADMISSION === "open" ? "open" : "closed";

function admission() {
	try {
		const value = JSON.parse(readFileSync(gatePath, "utf8"));
		return value.admission === "open" ? "open" : "closed";
	} catch {
		return fallback;
	}
}

function active() {
	try {
		const value = JSON.parse(readFileSync(activityPath, "utf8"));
		const count = Number(value.active ?? value.activeGpuJobs ?? 0);
		return Number.isSafeInteger(count) && count >= 0 ? count : 0;
	} catch {
		return 0;
	}
}

let observed = admission();
if (action !== "status") {
	observed = action === "open" ? "open" : "closed";
	mkdirSync(dirname(gatePath), { recursive: true });
	const temporary = `${gatePath}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ admission: observed, updatedAt: new Date().toISOString() })}\n`, { mode: 0o660 });
	renameSync(temporary, gatePath);
}
process.stdout.write(`${JSON.stringify({ admission: observed, active: active() })}\n`);
