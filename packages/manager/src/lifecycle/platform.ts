import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashApiKey, validatePlatformConfiguration } from "@ai-platform/common";
import { readCatalog } from "../core/catalog.js";
import { localImageReadiness } from "./local-build.js";
import { event, setSetting, setting } from "../core/store.js";
import { paths } from "../core/paths.js";import { hashHermesPassword } from "./hermes/password.js";
import { ensurePlatformTls } from "./certificates/tls.js";import { activateManagerCertificate } from "./certificates/activation.js";import { imageVariables } from "../core/image-variables.js";
import { summarizeComposeStatus, type ProductStatus } from "./status.js";
import { activeProfile, qualificationStatus, runCampaign } from "./qualification/index.js";import { reconcileLabEdge } from "./lab/edge.js";import { migrationDiagnostics } from "./migrations/diagnostics.js";
import { objectStoreAccessId, secretGeneration } from "./storage/identities.js";
const products = {
	inference: {
		compose: "/usr/lib/treeseed-ai/inference/compose.yml",
		overlay: "/usr/lib/treeseed-ai/inference/factory.override.yml",
		environment: "/etc/treeseed-ai/inference/environment",
	},
	training: {
		compose: "/usr/lib/treeseed-ai/training/compose.yml",
		overlay: "/usr/lib/treeseed-ai/training/factory.override.yml",
		environment: "/etc/treeseed-ai/training/environment",
	},
} as const,
	bases = {
		inference: ["postgres", "minio", "migrations", "evaluator", "manager", "api"],
		training: ["postgres", "minio", "migrations", "artifact", "manager", "api"],
} as const;
function command(file: string, args: string[]) {
	const result = spawnSync(file, args, { encoding: "utf8", timeout: 900_000 }); if (result.status !== 0) throw new Error(`${file} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout.trim();
}
function atomic(path: string, value: string, mode = 0o600) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o750 });if(existsSync(path)&&readFileSync(path,"utf8")===value){chmodSync(path,mode);return;}
	const next = `${path}.new`;
	writeFileSync(next, value, { mode });
	renameSync(next, path);
	chmodSync(path, mode);
}
function mounted(path:string,value:string,mode=0o640){mkdirSync(dirname(path),{recursive:true,mode:0o750});if(existsSync(path))writeFileSync(path,value,{mode});else atomic(path,value,mode);chmodSync(path,mode);}function secret(bytes = 32) { return randomBytes(bytes).toString("hex"); }
function credential(id: string, scopes: string[]) {
	const value = randomBytes(32).toString("base64url");
	return {
		plain: `ak_${id}_${value}`,
		record: { id, hash: hashApiKey(value), scopes, revoked: false },
	};
}
function envMap(path: string) {
	const values: Record<string, string> = {};
	if (!existsSync(path)) return values;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
		if (match) values[match[1]!] = match[2]!.replace(/^'|'$/gu, "");
	}
	return values;
}
function enabledProducts() {
	const config = JSON.parse(readFileSync(paths.configuration, "utf8")) as {
		products: string[];
	};
	return new Set(config.products);
}
function environment(path: string, values: Record<string, string>, group: string) {
	let content = existsSync(path) ? readFileSync(path, "utf8") : "";
	for (const [name, value] of Object.entries(values)) {
		content = content
			.split("\n")
			.filter((line) => line && !line.startsWith(`${name}=`))
			.join("\n");
		content += `${content ? "\n" : ""}${name}=${value}`;
	}
	atomic(path, `${content}\n`, 0o640);
	try {
		execFileSync("chown", [`root:${group}`, path]);
	} catch {}
}
function compose(product: keyof typeof products, args: string[]) { const item = products[product]; return command("docker", ["compose", "-p", `treeseed-ai-${product}`, "--env-file", item.environment, "-f", item.compose, "-f", item.overlay, ...args]); }
function reconcileProduct(product:keyof typeof products,args:string[]){try{return compose(product,args);}catch(error){const diagnostics=migrationDiagnostics(product,products[product]),message=error instanceof Error?error.message:String(error);throw new Error(diagnostics?`${message}\nMigration diagnostics:\n${diagnostics}`:message);}}function reconcileObjectStore(product:keyof typeof products){reconcileProduct(product,["up","-d","--wait","--wait-timeout","600","minio"]);reconcileProduct(product,["run","--rm","--no-deps","minio-init"]);}
export function ensureManagedRuntime() {
	const config = JSON.parse(readFileSync(paths.configuration, "utf8")) as {
		runtime: { management: string };
	};
	if (spawnSync("docker", ["compose", "version"]).status === 0) return;
	if (config.runtime.management !== "managed") throw new Error("An operator-managed Docker Compose runtime is unavailable.");
	const cli = "/usr/lib/treeseed-ai/host-runtime/dist/cli.js";
	if (!existsSync(cli)) throw new Error("Managed runtime package is not installed.");
	command("/usr/lib/treeseed-ai/runtime/bin/node", [cli, "apply", "--json"]);
	if (spawnSync("docker", ["compose", "version"]).status !== 0) throw new Error("Managed container runtime installation did not provide Docker Compose.");
}
const ensureRuntime = ensureManagedRuntime;
function ensureNetwork() {
	const inspect = spawnSync("docker", ["network", "inspect", "ai-shared", "--format", "{{.Driver}} {{.Scope}}"], { encoding: "utf8" });
	if (inspect.status === 0) {if (inspect.stdout.trim() !== "bridge local") throw new Error("Existing ai-shared network is incompatible.");return;}
	command("docker", ["network", "create", "--driver", "bridge", "--label", "org.treeseed-ai.manager=true", "ai-shared"]);
}
function imageValues(product: "inference" | "training") {
	const config = JSON.parse(readFileSync(paths.configuration, "utf8")) as {imageSource: string},
		catalog = readCatalog(),
		local = localImageReadiness(catalog),
		values: Record<string, string> = {},
		existing = envMap(products[product].environment);
	for (const image of catalog.images) {
		const variable = imageVariables[image.role],
			owned = image.role.startsWith(`${product}-`) || (product === "training" && ["axolotl-worker", "marker-worker", "artifact-worker"].includes(image.role));
		if (!variable || !owned) continue;
		if (catalog.imagePolicy.mode === "package-only") {
			if (!existing[variable]) throw new Error(`Package-only catalog cannot initialize missing ${variable}.`);
			values[variable] = existing[variable]!;continue;
		}
		const localId = local.images.get(image.role);
		if (catalog.imagePolicy.requiredLocalImages.some((item) => item.role === image.role) && !localId) throw new Error(`Required local image ${image.role} is not ready.`);
		if (!localId && image.localBuildOnly) throw new Error(`Catalog image ${image.role} has no production fallback.`);
		values[variable] = localId ?? (config.imageSource === "local-build" && catalog.channel === "stable" ? `local/${image.role}:${catalog.release}` : `${image.repository}@${image.digest}`);
	}
	return values;
}
function image(role: string) {
	const config = JSON.parse(readFileSync(paths.configuration, "utf8")) as {imageSource: string},
		catalog = readCatalog(),
		item = catalog.images.find((value) => value.role === role),
		local = localImageReadiness(catalog),
		localId = local.images.get(role);
	if (!item) throw new Error(`Catalog image ${role} is missing.`);
	if (catalog.imagePolicy.mode === "package-only") {
		const variable = imageVariables[role], current = variable ? envMap("/etc/treeseed-ai/lab/environment")[variable] : undefined;
		if (!current) throw new Error(`Package-only catalog cannot initialize missing ${variable ?? role}.`);return current;
	}
	if (catalog.imagePolicy.requiredLocalImages.some((value) => value.role === role) && !localId) throw new Error(`Required local image ${role} is not ready.`);
	if (!localId && item.localBuildOnly) throw new Error(`Catalog image ${role} has no production fallback.`);
	return localId ?? (config.imageSource === "local-build" && catalog.channel === "stable" ? `local/${role}:${catalog.release}` : `${item.repository}@${item.digest}`);
}
function runtimeImage(id: string) {const item = readCatalog().runtimeImages.find((value) => value.id === id);if (!item) throw new Error(`Catalog runtime image ${id} is missing.`);return item.reference;}
function productGroup(product: "inference" | "training" | "lab") {
	const group = `treeseed-ai-${product}`,
		record = command("getent", ["group", group]),
		gid = record.split(":")[2];
	if (!gid || !/^\d+$/u.test(gid)) throw new Error(`Cannot resolve ${group}.`);
	const runtime = `/run/treeseed-ai/${product}`;
	mkdirSync(runtime, { recursive: true, mode: 0o775 });
	chmodSync(runtime, 0o775);
	command("chown", [`root:${group}`, runtime]);
	return gid;
}
function secureLabSecret(path: string) { chmodSync(path, 0o640); command("chown", ["root:treeseed-ai-lab", path]); }
function ensureSigningMaterial() {
	const root = "/etc/treeseed-ai/manager/factory";
	mkdirSync(root, { recursive: true, mode: 0o750 });chmodSync(root, 0o750);command("chown", ["root:treeseed-ai-manager", root]);
	const privateKey = `${root}/artifact-signing-key.pem`,
		publicKey = `${root}/artifact-signing-public.pem`;
	if (!existsSync(privateKey)){command("openssl", ["genpkey", "-algorithm", "Ed25519", "-out", privateKey]);chmodSync(privateKey, 0o600);}
	const derivedPublicKey=`${command("openssl", ["pkey", "-in", privateKey, "-pubout"]).trim()}\n`;
	atomic(publicKey,derivedPublicKey,0o644);
	chmodSync(publicKey, 0o644);command("chown", ["root:treeseed-ai-manager", publicKey]);
	if(enabledProducts().has("training")){chmodSync(privateKey,0o640);command("chown",["root:treeseed-ai-training",privateKey]);}
	return { root, privateKey, publicKey };
}
function ensureServiceCredentials(root: string) {
	const path = `${root}/service-api-credentials.json`;
	const existing=existsSync(path)?JSON.parse(readFileSync(path,"utf8"))as Record<
			string,
			{
				plain: string;
				record: {
					id: string;
					hash: string;
					scopes: string[];
					revoked: boolean;
				};
			}
		>:{};
	const values = {
		factory: existing.factory??credential("lab-factory", ["platform:read", "platform:mode"]),
		inference: existing.inference??credential("lab-inference", ["*"]),
		training: existing.training??credential("lab-training", ["*"]),
		libraryIngest:existing.libraryIngest??credential('lab-library-ingest',['libraries:read','libraries:write','libraries:train']),
		libraryAction:existing.libraryAction??credential('lab-library-action',['lab:read','lab:write']),
	};
	atomic(path, JSON.stringify(values), 0o600);
	return values;
}
function ensureProductConfiguration() {
	const config = JSON.parse(readFileSync(paths.configuration, "utf8")) as {
			configurationId: string;
			state: { postgresql: string; objectStorage: string };
		},
		signing = ensureSigningMaterial(),
		service = ensureServiceCredentials(signing.root);
	if (config.state.postgresql !== "bundled" || config.state.objectStorage !== "bundled") return;
	const secretsPath = `${signing.root}/service-secrets.json`;
	let stored: Record<string, string>;
	if (existsSync(secretsPath)) stored = JSON.parse(readFileSync(secretsPath, "utf8"));
	else {
		const inference = envMap(products.inference.environment),
			training = envMap(products.training.environment),
			migrated = config.configurationId === "migrated-local-factory";
		stored = {
			inferenceDb: (migrated && inference.POSTGRES_PASSWORD) || secret(24),
			trainingDb: (migrated && training.POSTGRES_PASSWORD) || secret(24),
			inferenceS3: (migrated && inference.S3_SECRET_KEY) || secret(),
			trainingS3: (migrated && training.S3_SECRET_KEY) || secret(),
			inferenceMinio: (migrated && inference.MINIO_ROOT_PASSWORD) || secret(),
			trainingMinio: (migrated && training.MINIO_ROOT_PASSWORD) || secret(),
			artifactToken: existsSync(`${signing.root}/artifact-import-token`) ? readFileSync(`${signing.root}/artifact-import-token`, "utf8").trim() : secret(),
		};
	}
	stored.trainingImportS3??=secret();atomic(secretsPath, JSON.stringify(stored), 0o600);
	const accessIds={inference:objectStoreAccessId("inference",stored.inferenceS3!),training:objectStoreAccessId("training",stored.trainingS3!),trainingImport:objectStoreAccessId("trainingImport",stored.trainingImportS3)};
	const operator = JSON.parse(readFileSync("/etc/treeseed-ai/treeai/operator-record.json", "utf8")) as unknown,
		profile = activeProfile(),
		common = (product: "inference" | "training") => ({
			COMPOSE_PROFILES: "state",
			AI_API_KEYS: `'${JSON.stringify([operator, service[product]!.record,...product==='training'?[service.libraryIngest!.record]:[]])}'`,
			DATABASE_URL: `postgresql://${product}:${stored[`${product}Db`]}@postgres:5432/${product}`,
			POSTGRES_PASSWORD: stored[`${product}Db`]!,
			S3_ENDPOINT: `http://${product}-minio:9000`,
			S3_BUCKET: `ai-${product}`,
			S3_ACCESS_KEY: accessIds[product],S3_SECRET_KEY: stored[`${product}S3`]!,S3_CREDENTIAL_GENERATION: secretGeneration(`${accessIds[product]}\0${stored[`${product}S3`]!}`),
			MINIO_ROOT_USER: `${product}-root`,
			MINIO_ROOT_PASSWORD: stored[`${product}Minio`]!,
			...(product==="training"?{IMPORT_S3_ACCESS_KEY:accessIds.trainingImport,IMPORT_S3_SECRET_KEY:stored.trainingImportS3}:{}),
		});
	atomic(paths.apiKeys, `${JSON.stringify([operator, service.factory!.record], null, 2)}\n`, 0o640);
	try {
		command("chown", ["root:treeseed-ai-manager", paths.apiKeys]);
	} catch {}
	const enabled = enabledProducts();
	if (enabled.has("inference"))
		environment(
			products.inference.environment,
			{
				...imageValues("inference"),
				...common("inference"),
				RUNTIME_GID: productGroup("inference"),
				SOURCE_MODEL: "Qwen/Qwen3.5-4B",
				SOURCE_MODEL_REVISION: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
				MAX_MODEL_LENGTH: String(profile?.settings.maxModelLength ?? 16384), TREEAI_MULTIMODAL_LORA_ENABLED: String(profile?.settings.multimodalLoraEnabled === true),
			},
			"treeseed-ai-inference",
		);
	if (enabled.has("training"))
		environment(
			products.training.environment,
			{
				...imageValues("training"),
				...common("training"),
				RUNTIME_GID: productGroup("training"),
				SIGNING_KEY_FILE: signing.privateKey,
				SIGNING_KEY_ID: "training-local-0.6",
			},
			"treeseed-ai-training",
		);
	if (enabled.has("inference") && enabled.has("training")) {
		const artifactImportToken=`${stored.artifactToken!}\n`;mounted(`${signing.root}/artifact-import-token`, artifactImportToken);
		const source = {
			sourceId: "training-local",
			endpoint: "http://training-minio:9000",
			bucket: "ai-training",
			accessKeyId: accessIds.trainingImport,
			secretAccessKey: stored.trainingImportS3,
			trustedPublicKey: readFileSync(signing.publicKey, "utf8"),
		};
		const sourceValue=`${JSON.stringify(source, null, 2)}\n`;mounted(`${signing.root}/training-local-source.json`, sourceValue);for(const path of[`${signing.root}/artifact-import-token`,`${signing.root}/training-local-source.json`]){chmodSync(path,0o640);command("chown",["root:treeseed-ai-inference",path]);}
		environment(products.inference.environment,{ARTIFACT_SOURCE_SECRET_GENERATION:secretGeneration(sourceValue),ARTIFACT_IMPORT_TOKEN_GENERATION:secretGeneration(artifactImportToken)},"treeseed-ai-inference");
	}
}
function ensureLabConfiguration() {
	if (!enabledProducts().has("lab")) return;
	const root = "/etc/treeseed-ai/lab",
		secrets = `${root}/secrets`,
		factory = "/etc/treeseed-ai/manager/factory",
		service = ensureServiceCredentials(factory),
		operator = JSON.parse(readFileSync("/etc/treeseed-ai/treeai/operator-record.json", "utf8")) as unknown,
		config = validatePlatformConfiguration(
			JSON.parse(readFileSync(paths.configuration, "utf8")),
		),
		webui = config.lab?.webui ?? {
			authentication: "local-users" as const,
			browserUrl: "https://localhost:4791",
			binding: "0.0.0.0:4791",
		},
		localSingleUser = webui.authentication === "disabled";
	mkdirSync(secrets, { recursive: true, mode: 0o750 });
	for (const [name, value] of [
		["factory-control-key", service.factory!.plain],
		["factory-inference-key", service.inference!.plain],
		["factory-training-key", service.training!.plain],
		['training-ingest-key',service.libraryIngest!.plain],
		['lab-library-action-key',service.libraryAction!.plain],
	] as const)
		atomic(`${secrets}/${name}`, `${value}\n`);
	if (existsSync(`${factory}/training-local-source.json`)) copyFileSync(`${factory}/training-local-source.json`, `${root}/training-source.json`);
	const passwordPath = `${secrets}/hermes-dashboard-password`,
		hashPath = `${secrets}/hermes-password-hash`,
		sessionPath = `${secrets}/hermes-session-secret`,
		apiKeyPath = `${secrets}/hermes-api-key`;
	if (!existsSync(hashPath))
		atomic(hashPath, `${hashHermesPassword(randomBytes(24).toString("base64url"))}\n`);
	if (!existsSync(sessionPath)) atomic(sessionPath, `${randomBytes(32).toString("base64")}\n`);
	if (!existsSync(apiKeyPath)) atomic(apiKeyPath, `${randomBytes(32).toString("base64url")}\n`);
	if (existsSync(passwordPath)) {
		rmSync(passwordPath);
		event("lab.hermes.plaintext-password-removed", {});
	}
	for (const name of ["factory-control-key", "factory-inference-key", "factory-training-key",'training-ingest-key','lab-library-action-key', "hermes-password-hash", "hermes-session-secret", "hermes-api-key"])
		secureLabSecret(`${secrets}/${name}`);
	if (existsSync(`${root}/training-source.json`)) secureLabSecret(`${root}/training-source.json`);
	environment(
		`${root}/environment`,
		{
			AI_LAB_API_KEYS: `'${JSON.stringify([operator,service.libraryAction!.record])}'`,
			FACTORY_URL: "https://host.docker.internal:4790",
			TRAINING_URL: "http://training-api:4780",
			INFERENCE_CONTROL_URL: "http://inference-api:4770",
			INFERENCE_URL: "http://inference-api:4771",
			BASE_MODEL: "Qwen/Qwen3.5-4B",
			BASE_MODEL_REVISION: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
			HERMES_MODEL_CONTEXT_LENGTH: String(activeProfile()?.context.contextTokens ?? 16384),HERMES_OUTPUT_RESERVE: String(activeProfile()?.context.outputReserve ?? 2048),
			LAB_CONTROLLER_IMAGE: image("lab-controller"),
			LAB_PROXY_IMAGE: image("lab-experience-proxy"),
			LAB_LIBRARY_BRIDGE_IMAGE:image('lab-library-bridge'),
			LAB_WEB_TOOL_IMAGE: image("lab-web-tool-proxy"),
			HERMES_IMAGE: image("hermes-agent"),
			OPEN_WEBUI_IMAGE: runtimeImage("open-webui"),
			RUNTIME_GID: productGroup("lab"),
			OPEN_WEBUI_AUTH: localSingleUser ? "false" : "true",
			OPEN_WEBUI_ENABLE_SIGNUP: "false",
			OPEN_WEBUI_ENABLE_LOGIN_FORM: localSingleUser ? "false" : "true",
			OPEN_WEBUI_BYPASS_MODEL_ACCESS_CONTROL: localSingleUser ? "true" : "false",
			OPEN_WEBUI_URL: webui.browserUrl,
			OPEN_WEBUI_CORS_ALLOW_ORIGIN: webui.browserUrl,
			LAB_MIN_TRAJECTORIES: "100",
			LAB_IDLE_MINUTES: "15",
			LAB_COOLDOWN_HOURS: "6",
		},
		"treeseed-ai-lab",
	);
	const webuiPort = localSingleUser ? "127.0.0.1:443:443" : `${webui.binding}:4791`,
		controlHost = localSingleUser ? "127.0.0.1" : "0.0.0.0";
	atomic(
		`${root}/ports.override.yml`,
		`services:\n  gateway:\n    ports:\n      - "${webuiPort}"\n      - "${controlHost}:4793:4793"\n`,
		0o640,
	);
	command("chown", ["root:treeseed-ai-lab", `${root}/ports.override.yml`]);
}
function lab(args: string[]) {
	return command("docker", ["compose", "-p", "treeseed-ai-lab", "--env-file", "/etc/treeseed-ai/lab/environment", "-f", "/usr/lib/treeseed-ai/lab/compose.yml", "-f", "/etc/treeseed-ai/lab/ports.override.yml", ...args]);
}
export function stopManagedProduct(product: unknown) {
	if (product === "lab") lab(["down"]);
	else if (product === "inference" || product === "training") compose(product, ["down"]);
	else throw new Error("Component is not allowlisted.");
	event("component.stopped", { product });
	return { product, stopped: true };
}
function active(path: string) {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as {
			active?: number;
			activeGpuJobs?: number;
		};
		return Number(value.active ?? value.activeGpuJobs ?? 0);
		} catch { return 0; }
}
async function waitIdle(path: string, seconds: number) {
	for (let elapsed = 0; elapsed < seconds; elapsed++) {
		if (active(path) === 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return false;
}
function writeMode(mode: string, error?: string) {
	atomic(paths.mode, `${JSON.stringify({ schemaVersion: "treeai.mode/v1", mode, updatedAt: new Date().toISOString(), ...(error ? { error } : {}) }, null, 2)}\n`, 0o644);
	setSetting("mode", mode);
}
export function persistMode(mode: "awake" | "sleep") {
	writeMode(mode);
}
function gateway(args: string[]) { return command("docker", ["compose", "-p", "treeseed-ai-manager-gateway", "-f", "/usr/lib/treeseed-ai/manager/factory/compose.yml", ...args]); }
function warmInference() {
	command("docker", ["compose", "-p", "treeseed-ai-inference", "--env-file", products.inference.environment, "-f", products.inference.compose, "-f", products.inference.overlay, "exec", "-T", "vllm", "python3", "-c", "import json,urllib.request; b=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':'Reply ready.'}],'max_tokens':8}).encode(); r=urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=b,headers={'content-type':'application/json'}); urllib.request.urlopen(r,timeout=120).read()"]);
}
export function serviceStatus() {
	const result: Record<string, ProductStatus> = {},
		enabled = enabledProducts();
	for (const product of ["inference", "training"] as const)
		if (enabled.has(product))
			try {
				result[product] = summarizeComposeStatus(
					product,
					compose(product, ["ps", "--format", "json"]),
				);
			} catch {
				result[product] = {
					product,
					state: "degraded",
					services: [],
					error: "status_unavailable",
				};
			}
	if (enabled.has("lab"))
		try {
			result.lab = summarizeComposeStatus(
				"lab",
				lab(["ps", "--format", "json"]),
			);
		} catch {
			result.lab = {
				product: "lab",
				state: "degraded",
				services: [],
				error: "status_unavailable",
			};
		}
	return result;
}
export async function reconcilePlatform() {
	ensureRuntime();
	ensureNetwork();
	ensureProductConfiguration();
	ensureLabConfiguration();
	const configuration = validatePlatformConfiguration(JSON.parse(readFileSync(paths.configuration, "utf8"))),
		certificate = ensurePlatformTls(configuration);
	const mode = setting<string>("mode", "awake"),
		enabled = enabledProducts();
	if (!existsSync(paths.mode)) writeMode(mode);
	if(configuration.state.objectStorage==="bundled")for(const product of["inference","training"]as const)if(enabled.has(product))reconcileObjectStore(product);
	if (mode === "awake") {
		if (enabled.has("training")) {
			compose("training", ["stop", "marker", "axolotl"]);
			reconcileProduct("training", ["up", "-d", "--wait", "--wait-timeout", "600", ...bases.training]);
		}
		if (enabled.has("inference")) {
			reconcileProduct("inference", ["up", "-d", "--wait", "--wait-timeout", "900", ...bases.inference, "vllm"]);
			warmInference();
		}
	} else if (mode === "sleep") {
		if (enabled.has("inference")) {
			compose("inference", ["stop", "vllm"]);
			reconcileProduct("inference", ["up", "-d", "--wait", "--wait-timeout", "600", ...bases.inference]);
		}
		if (enabled.has("training")) reconcileProduct("training", ["up", "-d", "--wait", "--wait-timeout", "900", ...bases.training, "marker", "axolotl"]);
	} else throw new Error(`Unsafe persisted mode ${mode}; manual recovery is required.`);
	if (enabled.has("inference") || enabled.has("training")) gateway(["up", "-d", "--wait"]);
	try {
		if (enabled.has("lab")) reconcileLabEdge(lab, command, event);
	} catch (error) {
		certificate.rollback();
		throw error;
	}
	activateManagerCertificate(certificate, command);
	if (qualificationStatus().baselineRequired && mode === "awake" && runCampaign("baseline").state === "succeeded") ensureProductConfiguration();
	const services = serviceStatus();
	setSetting("components", services);
	event("components.reconciled", { mode });
	return { mode, services };
}
let transitionInFlight: { target: "awake" | "sleep"; promise: Promise<unknown> } | undefined;
async function runModeTransition(target: "awake" | "sleep", drain: { inferenceSeconds: number; trainingSeconds: number }) {
	const configuration=validatePlatformConfiguration(JSON.parse(readFileSync(paths.configuration,"utf8"))),current=setting<string>("mode","awake"),enabled=enabledProducts();
	if (current === target) {const reconciled=await reconcilePlatform();return { mode: target, changed: false, reconciled:true,services:reconciled.services };}const previous=current==="awake"||current==="sleep"?current:target==="sleep"?"awake":"sleep";writeMode(target === "awake" ? "transitioning_awake" : "transitioning_sleep");
	let lifecycleChanged = false;try {
		if (target === "sleep") {
			if (enabled.has("inference") && !(await waitIdle("/run/treeseed-ai/inference/status.json", drain.inferenceSeconds))) {
				writeMode(previous);
				return {
					mode: previous,
					state: "postponed",
					reason: "active_inference",
				};
			}
			if (enabled.has("inference")) compose("inference", ["stop", "vllm"]);
			lifecycleChanged = enabled.has("inference");
			if (enabled.has("training")) compose("training", ["up", "-d", "--wait", "--wait-timeout", "900", "marker", "axolotl"]);
		} else {
			if (enabled.has("training") && !(await waitIdle("/run/treeseed-ai/training/status.json", drain.trainingSeconds))) {
				writeMode(previous);
				return { mode: previous, state: "postponed", reason: "active_training" };
			}
			if (enabled.has("training")) compose("training", ["stop", "marker", "axolotl"]);
			lifecycleChanged = enabled.has("training");
			if (enabled.has("inference")) {
				compose("inference", ["up", "-d", "--wait", "--wait-timeout", "900", "vllm"]);
				warmInference();
			}
		}
		if(configuration.state.objectStorage==="bundled")for(const product of["inference","training"]as const)if(enabled.has(product))reconcileObjectStore(product);
		writeMode(target);
		event("mode.changed", { from: previous, to: target });
		return { mode: target, changed: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);writeMode(lifecycleChanged ? "degraded" : previous, message);throw error;
	}
}
export function transitionMode(target: unknown, drain: { inferenceSeconds: number; trainingSeconds: number }): Promise<unknown> {
	if (target !== "awake" && target !== "sleep") return Promise.reject(new Error("Mode must be awake or sleep."));if (transitionInFlight) {if (transitionInFlight.target !== target) return Promise.reject(new Error(`A transition to ${transitionInFlight.target} is already running.`));return transitionInFlight.promise;}
	const promise=runModeTransition(target,drain).finally(()=>{if(transitionInFlight?.promise===promise)transitionInFlight=undefined;});transitionInFlight={target,promise};return promise;
}
