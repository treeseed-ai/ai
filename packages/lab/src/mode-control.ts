import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import {
	aiModeRequestSchema,
	aiModeTransitionReceiptSchema,
	type AiMode,
	type AiModeTransitionReceipt,
} from "@treeseed/sdk/deployment";

const modePath = "/v1/ai/mode";
const credentialFiles = {
	ca: "/run/secrets/ai-mode-ca",
	certificate: "/run/secrets/ai-mode-client-cert",
	privateKey: "/run/secrets/ai-mode-client-key",
} as const;

export function modeRequest(target: AiMode, idempotencyKey: string, drainTimeoutSeconds = 900) {
	return aiModeRequestSchema.parse({
		schemaVersion: "treeseed.ai-mode-request/v1",
		target,
		idempotencyKey,
		drainTimeoutSeconds,
	});
}

export function modeEndpoint(environment: NodeJS.ProcessEnv = process.env) {
	const raw = environment.TREESEED_AI_MODE_URL;
	if (!raw) throw new Error("TREESEED_AI_MODE_URL is required");
	const url = new URL(raw);
	if (url.protocol !== "https:" || url.pathname !== modePath || url.username || url.password || url.search || url.hash) {
		throw new Error(`TREESEED_AI_MODE_URL must be an HTTPS ${modePath} endpoint`);
	}
	return url;
}

export async function requestManagedAiMode(target: AiMode, idempotencyKey: string, drainTimeoutSeconds = 900): Promise<AiModeTransitionReceipt> {
	const url = modeEndpoint(), body = JSON.stringify(modeRequest(target, idempotencyKey, drainTimeoutSeconds));
	const value = await new Promise<unknown>((resolve, reject) => {
		const request = httpsRequest(url, {
			method: "POST",
			ca: readFileSync(credentialFiles.ca),
			cert: readFileSync(credentialFiles.certificate),
			key: readFileSync(credentialFiles.privateKey),
			headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
			timeout: (drainTimeoutSeconds + 30) * 1_000,
		}, (response) => {
			const chunks: Buffer[] = []; let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > 1_048_576) request.destroy(new Error("AI mode response exceeded 1 MiB"));
				else chunks.push(chunk);
			});
			response.on("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				if ((response.statusCode ?? 500) >= 300) return reject(new Error(`AI mode request returned ${response.statusCode}: ${text.slice(0, 500)}`));
				try { resolve(JSON.parse(text)); } catch { reject(new Error("AI mode response was not JSON")); }
			});
		});
		request.on("timeout", () => request.destroy(new Error("AI mode request timed out")));
		request.on("error", reject);
		request.end(body);
	});
	return aiModeTransitionReceiptSchema.parse(value);
}
