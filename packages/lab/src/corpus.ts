import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";

interface Catalog {
	schemaVersion: string;
	generation: number;
	financial: {
		minimumUsableTokens: number;
		minimumIssuers: number;
		minimumHeldOutTokens: number;
		maximumRequestsPerSecond: number;
		issuers: Array<{ name: string; cik: string }>;
	};
	multimodal: { reports: Array<{ id: string; filename: string; url: string; sha256: string; size: number; provenance: string }> };
}
interface Client { ca: string; endpoints: Record<string, string> }
interface Response { body: Buffer; headers: Record<string, string | string[] | undefined>; status: number }

const catalogPath = process.env.TREEAI_QUALIFICATION_CORPUS_CATALOG ?? "/usr/share/treeseed-ai/lab/qualification-corpora.json";
const maximumObjectBytes = 100 * 1024 * 1024;
export function readCorpusCatalog(path = catalogPath) {
	const value = JSON.parse(readFileSync(path, "utf8")) as Catalog;
	if (value.schemaVersion !== "treeai.qualification-corpora/v1") throw new Error("Qualification corpus catalog is incompatible.");
	if (value.financial.maximumRequestsPerSecond > 5 || value.financial.minimumIssuers < 6 || value.financial.minimumUsableTokens < 500_000 || value.financial.minimumHeldOutTokens < 50_000) throw new Error("Qualification corpus policy is below the release minimum.");
	for (const report of value.multimodal.reports) if (!/^https:\/\/ntrs\.nasa\.gov\//u.test(report.url) || !/^[a-f0-9]{64}$/u.test(report.sha256) || report.size < 1) throw new Error("Qualification report metadata is invalid.");
	return value;
}
function cacheRoot(create = true) {
	const base = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "/tmp", ".cache");
	const path = join(base, "treeai", "qualification-corpora");
	if (create) mkdirSync(path, { recursive: true, mode: 0o750 });
	return path;
}
function digest(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function get(url: string, headers: Record<string, string> = {}) {
	return new Promise<Response>((resolve, reject) => {
		const request = httpsRequest(url, { headers }, (response) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk) => { bytes += chunk.length; if (bytes > maximumObjectBytes) response.destroy(new Error("Qualification object exceeds 100 MiB.")); else chunks.push(Buffer.from(chunk)); });
			response.on("end", () => {
				const status = response.statusCode ?? 0;
				if (status !== 304 && (status < 200 || status >= 300)) return reject(new Error(`GET ${new URL(url).hostname} returned ${status}`));
				resolve({ body: Buffer.concat(chunks), headers: response.headers as Response["headers"], status });
			});
		});
		request.on("error", reject);
		request.setTimeout(120_000, () => request.destroy(new Error("Corpus request timed out")));
		request.end();
	});
}
function send(url: string, body: Buffer, headers: Record<string, string>, ca: Buffer) {
	return new Promise<unknown>((resolve, reject) => {
		const request = httpsRequest(url, { method: "POST", headers: { ...headers, "content-length": String(body.length) }, ca }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			response.on("end", () => {
				const value = Buffer.concat(chunks).toString();
				if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) return reject(new Error(`Training ingestion returned ${response.statusCode}: ${value.slice(0, 500)}`));
				resolve(JSON.parse(value));
			});
		});
		request.on("error", reject);
		request.end(body);
	});
}
function store(name: string, body: Buffer, metadata: Record<string, unknown>) {
	const root = cacheRoot(), path = join(root, basename(name)), meta = `${path}.json`, checksum = digest(body);
	if (existsSync(path) && digest(readFileSync(path)) !== checksum) throw new Error(`Cached object ${name} changed unexpectedly.`);
	const next = `${path}.new`;
	writeFileSync(next, body, { mode: 0o640 });
	renameSync(next, path);
	writeFileSync(meta, `${JSON.stringify({ ...metadata, sha256: checksum, size: body.length, retrievedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o640 });
	return { path, sha256: checksum, size: body.length };
}
async function cachedGet(url: string, name: string, headers: Record<string, string>, metadata: Record<string, unknown>) {
	const path = join(cacheRoot(), basename(name)), metaPath = `${path}.json`;
	let prior: Record<string, unknown> = {};
	if (existsSync(metaPath)) prior = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
	const validators = { ...(typeof prior.etag === "string" ? { "if-none-match": prior.etag } : {}), ...(typeof prior.lastModified === "string" ? { "if-modified-since": prior.lastModified } : {}) };
	const response = await get(url, { ...headers, ...validators });
	if (response.status === 304) {
		if (!existsSync(path)) throw new Error(`Cached object ${name} is missing after a 304 response.`);
		return { body: readFileSync(path), stored: { path, sha256: String(prior.sha256), size: Number(prior.size) } };
	}
	const stored = store(name, response.body, { ...metadata, etag: response.headers.etag, lastModified: response.headers["last-modified"] });
	return { body: response.body, stored };
}
export function qualificationLibraryInput(name: string, slug: string) {
	return { sourceKind: "api" as const, externalId: slug, name, slug, description: "Non-production qualification corpus" };
}
async function library(client: Client, key: string, name: string, slug: string) {
	const body = Buffer.from(JSON.stringify(qualificationLibraryInput(name, slug)));
	return send(`${client.endpoints.training}/v1/libraries`, body, { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": `qualification-library:${slug}` }, readFileSync(client.ca)) as Promise<{ id: string }>;
}
async function upload(client: Client, key: string, libraryId: string, item: { externalId: string; filename: string; relativePath: string; mime: string; body: Buffer; provenance: Record<string, unknown> }) {
	const sha256 = digest(item.body);
	const metadata = Buffer.from(JSON.stringify({ externalId: item.externalId, filename: item.filename, relativePath: item.relativePath, declaredMimeType: item.mime, provenance: item.provenance })).toString("base64url");
	return send(`${client.endpoints.training}/v1/libraries/${libraryId}/documents`, item.body, { authorization: `Bearer ${key}`, "content-type": item.mime, "idempotency-key": `qualification-object:${item.externalId}:${sha256}`, "x-content-sha256": sha256, "x-treeai-document": metadata }, readFileSync(client.ca));
}
export function selectFiling(recent: Record<string, string[]>) {
	const rows = (recent.form ?? []).map((form, index) => ({ form, index }));
	const selected = rows.find((item) => item.form === "10-K") ?? rows.find((item) => item.form === "10-Q");
	if (!selected) throw new Error("Issuer has no eligible 10-K or fallback 10-Q.");
	return { form: selected.form, accession: String(recent.accessionNumber?.[selected.index]), primaryDocument: String(recent.primaryDocument?.[selected.index]), filingDate: String(recent.filingDate?.[selected.index]) };
}
export function corpusPlan() {
	const value = readCorpusCatalog();
	return { status: "ready", schemaVersion: value.schemaVersion, generation: value.generation, financial: { ...value.financial, issuerCount: value.financial.issuers.length }, multimodal: { reports: value.multimodal.reports.map(({ id, filename, sha256, size }) => ({ id, filename, sha256, size })) }, cache: cacheRoot(false) };
}
export async function acquireQualification(client: Client, key: string, userAgent: string) {
	if (!/^\S.+\s+[^\s@]+@[^\s@]+$/u.test(userAgent)) throw new Error("SEC_USER_AGENT must identify an organization and contact email.");
	const value = readCorpusCatalog(), financial = await library(client, key, "TreeAI EDGAR Qualification", "qualification-edgar"), visual = await library(client, key, "TreeAI NASA Multimodal Qualification", "qualification-nasa"), acquired = [];
	const throttle = () => new Promise((resolve) => setTimeout(resolve, Math.ceil(1000 / value.financial.maximumRequestsPerSecond)));
	for (const issuer of value.financial.issuers) {
		await throttle();
		const submissionUrl = `https://data.sec.gov/submissions/CIK${issuer.cik}.json`;
		const submission = await cachedGet(submissionUrl, `CIK${issuer.cik}.json`, { "user-agent": userAgent, "accept-encoding": "identity" }, { sourceUrl: submissionUrl, cik: issuer.cik, catalogGeneration: value.generation });
		const details = selectFiling(JSON.parse(submission.body.toString()).filings.recent), accession = details.accession.replace(/-/gu, ""), url = `https://www.sec.gov/Archives/edgar/data/${Number(issuer.cik)}/${accession}/${details.primaryDocument}`;
		await throttle();
		const { body, stored } = await cachedGet(url, `${issuer.cik}-${details.accession}.html`, { "user-agent": userAgent, "accept-encoding": "identity" }, { sourceUrl: url, issuer: issuer.name, cik: issuer.cik, ...details, catalogGeneration: value.generation });
		await upload(client, key, financial.id, { externalId: `sec:${details.accession}`, filename: basename(stored.path), relativePath: `Issuers/${issuer.name}/${basename(stored.path)}`, mime: "text/html", body, provenance: { source: "SEC EDGAR", sourceUrl: url, cik: issuer.cik, accession: details.accession, filingDate: details.filingDate, sha256: stored.sha256, catalogGeneration: value.generation } });
		acquired.push({ source: "sec", id: details.accession, sha256: stored.sha256, size: stored.size });
	}
	for (const report of value.multimodal.reports) {
		const { body, stored } = await cachedGet(report.url, report.filename, { "user-agent": "TreeAI Qualification/0.10 (https://github.com/treeseed-ai/ai)" }, { sourceUrl: report.url, reportId: report.id, provenance: report.provenance, catalogGeneration: value.generation });
		if (body.length !== report.size || digest(body) !== report.sha256) throw new Error(`NASA report ${report.id} differs from the release catalog.`);
		await upload(client, key, visual.id, { externalId: `nasa:${report.id}`, filename: report.filename, relativePath: `Reports/${report.filename}`, mime: "application/pdf", body, provenance: { source: "NASA NTRS", sourceUrl: report.url, reportId: report.id, sha256: stored.sha256, catalogGeneration: value.generation } });
		acquired.push({ source: "nasa", id: report.id, sha256: stored.sha256, size: stored.size });
	}
	return { status: "ready", generation: value.generation, libraries: { financial: financial.id, multimodal: visual.id }, acquired };
}
