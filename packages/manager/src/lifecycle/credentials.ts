import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { request } from "node:https";
import { execFileSync } from "node:child_process";
import { hashApiKey } from "@ai-platform/common";
import { paths } from "../core/paths.js";
import { reconcilePlatform } from "./platform.js";
const files = {
	key: "/etc/treeseed-ai/treeai/operator.key",
	record: "/etc/treeseed-ai/treeai/operator-record.json",
};
function delegate() {
	try {
		execFileSync("chown", ["root:treeseed-ai-operators", "/etc/treeseed-ai/treeai", files.key, files.record]);
		chmodSync("/etc/treeseed-ai/treeai", 0o750);
		chmodSync(files.key, 0o640);
		chmodSync(files.record, 0o640);
	} catch {}
}
function atomic(path: string, value: string, mode: number) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
	const temporary = `${path}.new`;
	writeFileSync(temporary, value, { mode });
	renameSync(temporary, path);
	chmodSync(path, mode);
}
function credential() {
	const secret = randomBytes(32).toString("base64url");
	return {
		plain: `ak_treeai-operator_${secret}`,
		record: {
			id: "treeai-operator",
			hash: hashApiKey(secret),
			scopes: ["*"],
			revoked: false,
		},
	};
}
function updateEnvironment(path: string, name: string, record: unknown) {
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line && !line.startsWith(`${name}=`));
	lines.push(`${name}='${JSON.stringify([record])}'`);
	atomic(path, `${lines.join("\n")}\n`, 0o640);
	const product = path.match(/\/treeseed-ai\/(inference|training|lab)\//u)?.[1];
	if (product)
		try {
			execFileSync("chown", [`root:treeseed-ai-${product}`, path]);
		} catch {}
}
function verify(plain: string) {
	return new Promise<void>((resolve, reject) => {
		const call = request(
			{
				hostname: "localhost",
				port: 4790,
				path: "/v1/version",
				method: "GET",
				ca: readFileSync("/etc/treeseed-ai/manager/tls/ca.crt"),
				headers: { authorization: `Bearer ${plain}` },
			},
			(response) => {
				response.resume();
				response.statusCode === 200
					? resolve()
					: reject(
							new Error(
								`New credential verification returned ${response.statusCode}.`,
							),
						);
			},
		);
		call.on("error", reject);
		call.end();
	});
}
export async function rotateOperatorCredential() {
	const targets = [
			paths.apiKeys,
			files.key,
			files.record,
			"/etc/treeseed-ai/inference/environment",
			"/etc/treeseed-ai/training/environment",
			"/etc/treeseed-ai/lab/environment",
		],
		backup = new Map(
			targets.filter(existsSync).map((path) => [path, readFileSync(path)]),
		),
		next = credential();
	try {
		atomic(files.key, `${next.plain}\n`, 0o640);
		atomic(files.record, `${JSON.stringify(next.record)}\n`, 0o640);
		atomic(paths.apiKeys, `${JSON.stringify([next.record], null, 2)}\n`, 0o640);
		try {
			execFileSync("chown", ["root:treeseed-ai-manager", paths.apiKeys]);
		} catch {}
		updateEnvironment(
			"/etc/treeseed-ai/inference/environment",
			"AI_API_KEYS",
			next.record,
		);
		updateEnvironment(
			"/etc/treeseed-ai/training/environment",
			"AI_API_KEYS",
			next.record,
		);
		updateEnvironment(
			"/etc/treeseed-ai/lab/environment",
			"AI_LAB_API_KEYS",
			next.record,
		);
		try {
			execFileSync("chown", [
				"root:treeseed-ai-operators",
				files.key,
				files.record,
			]);
		} catch {}
		try {
			execFileSync("systemctl", [
				"try-restart",
				"treeseed-ai-manager-api.service",
			]);
		} catch {}
		await reconcilePlatform();
		await verify(next.plain);
		return { rotated: true, keyId: next.record.id };
	} catch (error) {
		for (const [path, value] of backup) writeFileSync(path, value);
		for (const path of targets)
			if (!backup.has(path)) rmSync(path, { force: true });
		try {
			await reconcilePlatform();
			execFileSync("systemctl", ["try-restart", "treeseed-ai-manager-api.service"]);
			const previous = backup.get(files.key)?.toString().trim();
			if (previous) await verify(previous);
		} catch {}
		throw error;
	}
}
export function ensureOperatorCredential() {
	if (existsSync(files.key) && existsSync(files.record)) {
		delegate();
		return {
			plain: readFileSync(files.key, "utf8").trim(),
			record: JSON.parse(readFileSync(files.record, "utf8")),
		};
	}
	const next = credential();
	atomic(files.key, `${next.plain}\n`, 0o640);
	atomic(files.record, `${JSON.stringify(next.record)}\n`, 0o640);
	delegate();
	return next;
}
