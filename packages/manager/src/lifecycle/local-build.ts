import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../core/paths.js";
import { validateCatalog, type ReleaseCatalog } from "../core/catalog.js";
import { setting } from "../core/store.js";

interface PlannedImage {
	action: "built" | "reused";
	buildIdentity: string;
}
interface BuildPlan {
	images: Record<string, PlannedImage>;
}
export interface LocalBuildReceipt {
	schemaVersion: "treeai.local-build-receipt/v1";
	generation: number;
	release: string;
	source: string;
	sourceRevision: string;
	sourceDirty: boolean;
	sourceDigest: string;
	platform: "linux/amd64";
	createdAt: string;
	images: Array<{
		role: string;
		buildIdentity: string;
		tag: string;
		imageId: string;
		configDigest: string;
		baseDigest: string;
		smoke: "passed";
	}>;
}
export interface LocalImageReadiness {
	ready: boolean;
	required: Array<{ role: string; buildIdentity: string }>;
	reason?: string;
	images: Map<string, string>;
}
function receiptPath() {
	return process.env.TREEAI_LOCAL_BUILD_RECEIPT ?? paths.localBuildReceipt;
}
function run(file: string, args: string[], cwd?: string, inherit = false) {
	return execFileSync(file, args, {
		cwd,
		encoding: "utf8",
		stdio: inherit ? "inherit" : undefined,
	});
}
function stagedCatalog() {
	const generation = setting<number>("stagedGeneration", 0);
	const candidates = [
		join(paths.state, `staged-catalog-${generation}.json`),
		paths.catalog,
	];
	const path = candidates.find(existsSync);
	if (!path) throw new Error("No staged release catalog is available.");
	return validateCatalog(JSON.parse(readFileSync(path, "utf8")));
}
function sourcePlan(source: string, catalog: ReleaseCatalog) {
	const output = join(paths.state, `local-image-plan-${process.pid}.json`),
		prior = join(paths.state, `local-image-prior-${process.pid}.json`);
	mkdirSync(paths.state, { recursive: true, mode: 0o2770 });
	writeFileSync(prior, JSON.stringify({
		schemaVersion: "treeai.images/v2",
		version: catalog.imagePolicy.productionManifestVersion,
		images: Object.fromEntries(catalog.images.map((image) => [image.role, {
			repository: image.repository,
			digest: image.digest,
			tag: catalog.imagePolicy.productionManifestVersion,
			buildIdentity: image.buildIdentity,
			firstBuiltVersion: catalog.imagePolicy.productionManifestVersion,
		}])),
	}), { mode: 0o600 });
	run(
		process.execPath,
		[
			"--import",
			"tsx",
			"scripts/release/plan-image-builds.ts",
			output,
			prior,
		],
		source,
	);
	const value = JSON.parse(readFileSync(output, "utf8")) as BuildPlan;
	rmSync(output, { force: true });
	rmSync(prior, { force: true });
	return value;
}
function sourceRoot(requested: string) {
	const source = realpathSync(requested);
	for (const file of [
		"release/manifest.json",
		"release/image-builds.json",
		"scripts/release/plan-image-builds.ts",
	])
		if (!existsSync(join(source, file)))
			throw new Error("The source root is not a complete TreeAI checkout.");
	return source;
}
function requirements(catalog: ReleaseCatalog, plan: BuildPlan) {
	const required = catalog.imagePolicy.requiredLocalImages;
	for (const item of required)
		if (plan.images[item.role]?.buildIdentity !== item.buildIdentity)
			throw new Error(
				`Source does not match required build identity for ${item.role}.`,
			);
	return required;
}
function localTag(catalog: ReleaseCatalog, role: string) {
	return `local/${role}:dev-${catalog.imagePolicy.sourceRevision.slice(0, 12)}-g${catalog.generation}`;
}
function inspect(tag: string) {
	return JSON.parse(
		run("docker", ["image", "inspect", tag, "--format", "{{json .}}"]),
	) as {
		Id: string;
		Architecture: string;
		Config?: { Labels?: Record<string, string> };
	};
}
const smokeCommands: Record<string, string[]> = {
	"inference-api": ["node", "--check", "/app/packages/inference-api/dist/main.js"],
	"inference-manager": ["node", "--check", "/app/packages/inference-manager/dist/main.js"],
	"training-api": ["node", "--check", "/app/packages/training-api/dist/main.js"],
	"training-manager": ["node", "--check", "/app/packages/training-manager/dist/main.js"],
	"lab-controller": ["node", "--check", "/app/packages/lab/dist/controller.js"],
	"lab-experience-proxy": ["node", "--check", "/app/packages/lab/dist/proxy.js"],
	"inference-vllm": ["python3", "-c", "import vllm"],
	"inference-evaluator": ["python", "-c", "import ast,pathlib;ast.parse(pathlib.Path('/app/evaluator/worker.py').read_text())"],
	"artifact-worker": ["python", "-c", "import ast,pathlib;ast.parse(pathlib.Path('/app/artifact/worker.py').read_text())"],
	"marker-worker": ["python3", "-c", "import marker,boto3"],
	"axolotl-worker": ["python3", "-c", "import axolotl,accelerate"],
	"inference-migrations": ["sh", "-c", "test -s /migrations/001_initial.sql"],
	"training-migrations": ["sh", "-c", "test -s /migrations/001_initial.sql"],
	"hermes-agent": ["python", "-c", "from importlib.metadata import version;assert version('hermes-agent')=='0.18.2'"],
};
function smoke(role: string, tag: string) {
	const detail = inspect(tag);
	if (detail.Architecture !== "amd64")
		throw new Error(`${role} local image is not linux/amd64.`);
	if (detail.Config?.Labels?.["org.treeseed-ai.role"] !== role)
		throw new Error(`${role} local image role label is invalid.`);
	const check = smokeCommands[role];
	if (!check) throw new Error(`No packaged smoke check exists for ${role}.`);
	run("docker", ["run", "--rm", "--entrypoint", check[0]!, tag, ...check.slice(1)]);
	return detail;
}
export function planLocalBuild(requested: string) {
	const source = sourceRoot(requested),
		catalog = stagedCatalog(),
		plan = sourcePlan(source, catalog),
		required = requirements(catalog, plan),
		revision = run("git", ["rev-parse", "HEAD"], source).trim();
	if (catalog.imagePolicy.mode === "local-images-required" && revision !== catalog.imagePolicy.sourceRevision)
		throw new Error(`Source revision ${revision} does not match required revision ${catalog.imagePolicy.sourceRevision}.`);
	return {
		status: "ready",
		generation: catalog.generation,
		release: catalog.release,
		policy: catalog.imagePolicy.mode,
		source,
		sourceRevision: revision,
		required,
	};
}
export function buildLocalImages(requested: string) {
	const planned = planLocalBuild(requested), catalog = stagedCatalog();
	if (!planned.required.length)
		throw new Error("The staged generation does not require local images.");
	const revision = run("git", ["rev-parse", "HEAD"], planned.source).trim(),
		dirty = Boolean(
			run("git", ["status", "--porcelain"], planned.source).trim(),
		),
		createdAt = new Date().toISOString(),
		environment = {
			...process.env,
			AI_VERSION: `dev-${planned.sourceRevision.slice(0, 12)}-g${planned.generation}`,
			AI_SOURCE_REVISION: revision,
			AI_SOURCE_DIGEST: createHash("sha256")
				.update(
					planned.required
						.map((item) => `${item.role}:${item.buildIdentity}`)
						.sort()
						.join("\n"),
				)
				.digest("hex"),
			AI_BUILD_DATE: createdAt,
		};
	for (const item of planned.required) {
		const bake = item.role.startsWith("lab-") || item.role === "hermes-agent"
			? "deploy/lab/docker-bake.hcl"
			: "deploy/factory/docker-bake.hcl";
		execFileSync("docker", ["buildx", "bake", "-f", bake, "--load", item.role], {
			cwd: planned.source,
			env: environment,
			stdio: "inherit",
		});
	}
	const images = planned.required.map((item) => {
		const tag = localTag(catalog, item.role),
			detail = smoke(item.role, tag),
			labels = detail.Config?.Labels ?? {};
		return {
			role: item.role,
			buildIdentity: item.buildIdentity,
			tag,
			imageId: detail.Id,
			configDigest: detail.Id,
			baseDigest: labels["org.opencontainers.image.base.digest"] ?? "unknown",
			smoke: "passed" as const,
		};
	});
	const receipt: LocalBuildReceipt = {
		schemaVersion: "treeai.local-build-receipt/v1",
		generation: planned.generation,
		release: planned.release,
		source: planned.source,
		sourceRevision: revision,
		sourceDirty: dirty,
		sourceDigest: environment.AI_SOURCE_DIGEST,
		platform: "linux/amd64",
		createdAt,
		images,
	};
	const target = receiptPath(), temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(temporary, target);
	return receipt;
}
export function localImageReadiness(catalog: ReleaseCatalog): LocalImageReadiness {
	if (catalog.imagePolicy.mode === "package-only")
		return { ready: true, required: [], images: new Map<string, string>() };
	const path = receiptPath();
	if (!existsSync(path))
		return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: "local_build_receipt_missing", images: new Map<string, string>() };
	const receipt = JSON.parse(
		readFileSync(path, "utf8"),
	) as LocalBuildReceipt,
		images = new Map<string, string>();
	if (
		receipt.schemaVersion !== "treeai.local-build-receipt/v1" ||
		receipt.generation !== catalog.generation ||
		receipt.release !== catalog.release ||
		receipt.sourceRevision !== catalog.imagePolicy.sourceRevision ||
		receipt.platform !== "linux/amd64"
	)
		return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: "local_build_receipt_mismatch", images };
	for (const required of catalog.imagePolicy.requiredLocalImages) {
		const built = receipt.images?.find(
			(item) =>
				item.role === required.role &&
				item.buildIdentity === required.buildIdentity,
		);
		if (!built || receipt.generation !== catalog.generation)
			return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: `local_build_receipt_mismatch:${required.role}`, images };
		if (
			built.smoke !== "passed" ||
			!/^sha256:[a-f0-9]{64}$/u.test(built.imageId) ||
			built.configDigest !== built.imageId ||
			!/^sha256:[a-f0-9]{64}$/u.test(built.baseDigest)
		)
			return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: `local_build_receipt_invalid:${required.role}`, images };
		try {
			if (inspect(built.tag).Id !== built.imageId)
				return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: `local_image_moved:${required.role}`, images };
		} catch {
			return { ready: false, required: catalog.imagePolicy.requiredLocalImages, reason: `local_image_missing:${required.role}`, images };
		}
		images.set(required.role, built.imageId);
	}
	return { ready: true, required: catalog.imagePolicy.requiredLocalImages, images };
}
