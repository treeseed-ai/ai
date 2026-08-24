import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { finalizeConfiguration, validatePlatformConfiguration } from "@ai-platform/common";
import { validateCatalog, type ReleaseCatalog } from "../core/catalog.js";
import { event, setSetting, setting } from "../core/store.js";
import { paths } from "../core/paths.js";
import { securePlatformConfiguration } from "../core/configuration-file.js";
import { ensureManagedRuntime, persistMode, reconcilePlatform } from "./platform.js";
import { buildCatalogLocalImages, localImageReadiness } from "./local-build.js";
import { assertCatalogedSimulation } from "./apt-policy.js";
import { aptOptions } from "../core/apt-options.js";
import { activeWork } from "./update/admission.js";
export { recordsAreActive } from "./update/admission.js";
export { aptOptions } from "../core/apt-options.js";
const allowedPackages = new Set(["treeseed-ai", "treeseed-ai-archive-keyring", "treeseed-ai-development-archive-keyring", "treeseed-ai-host-js-runtime", "treeseed-ai-manager", "treeseed-ai-cli", "treeseed-ai-release-catalog", "treeseed-ai-host-runtime", "treeseed-ai-inference", "treeseed-ai-training", "treeseed-ai-lab", "treeseed-ai-factory"]);
function configuration() { return validatePlatformConfiguration(JSON.parse(readFileSync(paths.configuration, "utf8"))); }
function command(file: string, args: string[], cwd?: string) {
	const result = spawnSync(file, args, { encoding: "utf8", cwd });
	if (result.status !== 0) throw new Error(`${file} failed: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}
function exactPackages(catalog: ReleaseCatalog, products = configuration().products) {
	for (const item of catalog.packages) if (!allowedPackages.has(item.name)) throw new Error(`Uncataloged package ${item.name}.`);
	const desired = new Set(["treeseed-ai-archive-keyring", "treeseed-ai-development-archive-keyring", "treeseed-ai-host-js-runtime", "treeseed-ai-manager", "treeseed-ai-cli", "treeseed-ai-release-catalog", "treeseed-ai-factory", ...products.map((product) => `treeseed-ai-${product}`)]),
		central = catalog.packages.find((item) => item.name === "treeseed-ai"),
		installed = spawnSync("dpkg-query", ["-W", "-f=${Version}", "treeseed-ai"], { encoding: "utf8" }).stdout.trim();
	if (central && (!installed || spawnSync("dpkg", ["--compare-versions", central.version, "gt", installed]).status === 0)) desired.add("treeseed-ai");
	return [...catalog.packages]
		.filter((item) => desired.has(item.name))
		.sort((a, b) => a.order - b.order)
		.map((item) => `${item.name}=${item.version}`);
}
function candidateCatalog(channel: "stable" | "development") {
	const stage = join(paths.state, "candidate-catalog");
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true, mode: 0o700 });
	command("apt-get", [...aptOptions(channel), "download", "treeseed-ai-release-catalog"], stage);
	const packages = readdirSync(stage).filter((name) => /^treeseed-ai-release-catalog_.+_(all|amd64)\.deb$/u.test(name));
	if (packages.length !== 1) throw new Error("APT did not return exactly one candidate release catalog.");
	const unpack = join(stage, "unpacked");
	mkdirSync(unpack);
	command("dpkg-deb", ["--extract", join(stage, packages[0]!), unpack]);
	return validateCatalog(JSON.parse(readFileSync(join(unpack, "usr/share/treeseed-ai/release/catalog.json"), "utf8")));
}
function persistCandidate(catalog: ReleaseCatalog) {
	const target = join(paths.state, `staged-catalog-${catalog.generation}.json`),
		temporary = `${target}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o640 });
	renameSync(temporary, target);
}
function previousReceipt() {
	const generation = setting<number>("knownGoodGeneration", 0),
		path = join(paths.state, `generation-${generation}.json`);
	return generation && existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as {
				images: Array<{ role: string; digest: string }>;
				localImages?: Array<{ role: string; imageId: string }>;
				runtimeImages?: Array<{ id: string; digest: string }>;
			})
		: undefined;
}
function selectedImages(catalog: ReleaseCatalog) {
	const products = new Set(configuration().products),
		owned = (role: string) => (products.has("inference") && role.startsWith("inference-")) || (products.has("training") && (role.startsWith("training-") || ["axolotl-worker", "marker-worker", "artifact-worker"].includes(role))) || (products.has("lab") && (role.startsWith("lab-") || role === "hermes-agent"));
	return catalog.images.filter((item) => owned(item.role));
}
function changedImages(catalog: ReleaseCatalog) {
	const previous = new Map(previousReceipt()?.images.map((item) => [item.role, item.digest]) ?? []);
	return selectedImages(catalog).filter((item) => previous.get(item.role) !== item.digest);
}
function selectedRuntimeImages(catalog: ReleaseCatalog) {
	const products = new Set(["manager", ...configuration().products]);
	return catalog.runtimeImages.filter((item) => item.consumers.some((consumer) => products.has(consumer)));
}
function changedRuntimeImages(catalog: ReleaseCatalog) {
	const previous = new Map(previousReceipt()?.runtimeImages?.map((item) => [item.id, item.digest]) ?? []);
	return selectedRuntimeImages(catalog).filter((item) => previous.get(item.id) !== item.digest);
}
export function managementOnly(catalog: ReleaseCatalog) { return catalog.packageSet === "management"; }
export function checkForUpdate() {
	const config = configuration(),
		channel = config.updates.channel;
	command("apt-get", [...aptOptions(channel), "update"]);
	const catalog = candidateCatalog(channel),
		known = setting<number>("catalogGeneration", 0),
		changed = catalog.generation !== known;
	if (catalog.channel !== channel) throw new Error("Candidate catalog channel differs from configured channel.");
	persistCandidate(catalog);
	setSetting("lastMetadataCheck", new Date().toISOString());
	setSetting("catalogGeneration", catalog.generation);
	if (changed) setSetting("stagedGeneration", catalog.generation);
	event(changed ? "update.detected" : "update.unchanged", {
		generation: catalog.generation,
		channel,
	});
	return {
		changed,
		generation: catalog.generation,
		channel,
		classification: catalog.classification,
		automatic: catalog.automatic,
	};
}
export function planUpdate(input?: ReleaseCatalog) {
	const config = configuration(),
		catalog = input ?? candidateCatalog(config.updates.channel),
		packages = exactPackages(catalog),
		installed = setting<number>("knownGoodGeneration", 0);
	if (catalog.channel !== config.updates.channel) throw new Error("Selected APT suite does not match the catalog.");
	persistCandidate(catalog);
	if (catalog.generation < installed) throw new Error("Implicit catalog downgrade refused.");
	if (catalog.classification === "blocked") throw new Error("The candidate catalog is blocked.");
	const simulation = command("apt-get", [...aptOptions(config.updates.channel), "-s", "--no-remove", "--no-install-recommends", "install", ...packages]);
	assertCatalogedSimulation(simulation, catalog);
	const packageOnly = managementOnly(catalog),
		plan = {
		schemaVersion: "treeai.update-plan/v1",
		generation: catalog.generation,
		channel: catalog.channel,
		packages,
		images: packageOnly ? [] : changedImages(catalog),
		runtimeImages: packageOnly ? [] : changedRuntimeImages(catalog),
		migrations: packageOnly ? [] : catalog.migrations,
		gates: catalog.gates,
		automatic: catalog.automatic && catalog.classification === "automatic",
		imagePolicy: catalog.imagePolicy,
		localImages: packageOnly ? { ready: true, required: [], images: new Map<string, string>() } : localImageReadiness(catalog),
		simulationDigest: createHash("sha256").update(simulation).digest("hex"),
	};
	event("update.planned", {
		generation: catalog.generation,
		images: plan.images.length + plan.runtimeImages.length,
	});
	return { ...plan, simulation };
}
function snapshot(catalog: ReleaseCatalog) {
	const root = join(paths.state, `transaction-${catalog.generation}`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true, mode: 0o700 });
	copyFileSync(paths.configuration, join(root, "platform.json"));
	for (const product of configuration().products.filter((item) => item === "inference" || item === "training")) {
		const environment = `/etc/treeseed-ai/${product}/environment`;
		if (existsSync(environment)) copyFileSync(environment, join(root, `${product}.environment`));
	}
	const selections = command("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\t${db:Status-Abbrev}\n", "treeseed-ai*"]);
	writeFileSync(join(root, "package-selections.tsv"), selections, {
		mode: 0o600,
	});
	if (setting<number>("knownGoodGeneration", 0) > 0 && catalog.rollback.requiresBackup) {
		const config = configuration();
		if (config.state.postgresql !== "bundled") throw new Error("Catalog requires database backups; configure an external backup provider before applying.");
		for (const product of config.products.filter((item) => item === "inference" || item === "training")) {
			const file = `/usr/lib/treeseed-ai/${product}/compose.yml`,
				environment = `/etc/treeseed-ai/${product}/environment`,
				result = spawnSync("docker", ["compose", "-p", `treeseed-ai-${product}`, "--env-file", environment, "-f", file, "exec", "-T", "postgres", "pg_dump", "-U", product, product], { encoding: null, maxBuffer: 1024 * 1024 * 1024 });
			if (result.status !== 0) throw new Error(`Database backup failed for ${product}: ${String(result.stderr).trim()}`);
			writeFileSync(join(root, `${product}.sql`), result.stdout, {
				mode: 0o600,
			});
		}
	}
	const record = {
		schemaVersion: "treeai.transaction-snapshot/v1",
		generation: catalog.generation,
		knownGoodGeneration: setting("knownGoodGeneration", 0),
		configurationDigest: createHash("sha256").update(readFileSync(paths.configuration)).digest("hex"),
		packagesDigest: createHash("sha256").update(selections).digest("hex"),
		createdAt: new Date().toISOString(),
	};
	writeFileSync(join(root, "receipt.json"), JSON.stringify(record, null, 2), {
		mode: 0o600,
	});
	event("update.snapshot", { generation: catalog.generation, path: root });
	return root;
}
function receipt(catalog: ReleaseCatalog, packages: string[], state: string) {
	mkdirSync(paths.state, { recursive: true, mode: 0o2770 });
	const knownGood = join(paths.state, `known-good-${catalog.generation}`);
	rmSync(knownGood, { recursive: true, force: true });
	mkdirSync(knownGood, { recursive: true, mode: 0o700 });
	copyFileSync(paths.configuration, join(knownGood, "platform.json"));
	for (const product of configuration().products.filter((item) => item === "inference" || item === "training" || item === "lab")) {
		const environment = `/etc/treeseed-ai/${product}/environment`;
		if (existsSync(environment)) copyFileSync(environment, join(knownGood, `${product}.environment`));
	}
	const prior = previousReceipt(), packageOnly = managementOnly(catalog), localImages = packageOnly ? { ready: true, required: [], images: new Map<string, string>() } : localImageReadiness(catalog);
	const value = {
			schemaVersion: "treeai.update-receipt/v1",
			generation: catalog.generation,
			state,
			mode: setting("mode", "awake"),
			packages,
		images: packageOnly && prior ? prior.images : selectedImages(catalog),
		localImages: packageOnly && prior?.localImages ? prior.localImages : [...localImages.images].map(([role, imageId]) => ({ role, imageId })),
		runtimeImages: packageOnly && prior?.runtimeImages ? prior.runtimeImages : selectedRuntimeImages(catalog),
			rollback: catalog.rollback,
			knownGood,
			createdAt: new Date().toISOString(),
		},
		target = join(paths.state, `generation-${catalog.generation}.json`),
		temporary = `${target}.tmp`;
	writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
	renameSync(temporary, target);
	setSetting("catalogGeneration", catalog.generation);
	return target;
}
async function pullImage(role: string, reference: string) {
	process.stdout.write(`[image:${role}] pull started\n`);
	const child = spawn("docker", ["pull", "--quiet", reference], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let error = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		error = `${error}${chunk}`.slice(-65_536);
	});
	const started = Date.now(),
		progress = setInterval(() => {
			const seconds = Math.floor((Date.now() - started) / 1000);
			process.stdout.write(`[image:${role}] pull waiting ${seconds}s\n`);
		}, 15_000);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		if (code !== 0)
			throw new Error(
				`docker pull failed for ${role}: ${error.trim() || `exit ${code}`}`,
			);
	} finally {
		clearInterval(progress);
	}
	process.stdout.write(`[image:${role}] pull completed\n`);
}
async function acquireImages(catalog: ReleaseCatalog) {
	for (const image of changedImages(catalog)) {
		if (catalog.imagePolicy.requiredLocalImages.some((item) => item.role === image.role)) continue;
		const reference = `${image.repository}@${image.digest}`;
		await pullImage(image.role, reference);
		const actual = command("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", reference]).trim();
		if (!actual.endsWith(`@${image.digest}`)) throw new Error(`Pulled digest differs for ${image.role}.`);
		event("image.verified", {
			role: image.role,
			digest: image.digest,
			evidence: "signed-catalog-and-registry-digest",
		});
	}
	for (const image of changedRuntimeImages(catalog)) {
		await pullImage(image.id, image.reference);
		const actual = command("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", image.reference]).trim();
		if (!actual.endsWith(`@${image.digest}`)) throw new Error(`Pulled digest differs for runtime image ${image.id}.`);
		event("image.verified", {
			role: image.id,
			digest: image.digest,
			evidence: "signed-catalog-and-registry-digest",
		});
	}
}
function health() {
	if (spawnSync("systemctl", ["is-active", "--quiet", "treeseed-ai-manager-api.service"]).status !== 0) return;
	const result = spawnSync("curl", ["--silent", "--show-error", "--fail", "--cacert", "/etc/treeseed-ai/manager/tls/ca.crt", "https://localhost:4790/healthz"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Manager health gate failed: ${result.stderr.trim()}`);
}
export async function applyUpdate() {
	const config = configuration(),
		catalog = candidateCatalog(config.updates.channel),
		packages = exactPackages(catalog),
		packageOnly = managementOnly(catalog);
	if (catalog.generation === setting("knownGoodGeneration", 0) && setting("stagedGeneration", null) === null) return { state: "unchanged", generation: catalog.generation, packageOnly };
	if (setting("updatesPaused", false)) return { state: "postponed", reason: "updates_paused" };
	let plan = planUpdate(catalog);
	if (!plan.automatic && setting("automaticInvocation", false)) return { state: "postponed", reason: "local_approval_required" };
	event("update.acquiring", { generation: catalog.generation }); command("apt-get", [...aptOptions(config.updates.channel), "--download-only", "--no-remove", "--no-install-recommends", "install", ...packages]);
	if (
		!plan.localImages.ready &&
		setting("automaticInvocation", false) &&
		config.updates.channel === "development" &&
		config.updates.policy === "continuous"
	) {
		event("root-capability.started", {
			operation: "development.local-images.build",
			generation: catalog.generation,
			configuredImageSource: config.imageSource,
			requiredRoles: catalog.imagePolicy.requiredLocalImages.map((item) => item.role),
		});
		try {
			const built = buildCatalogLocalImages(catalog);
			event("root-capability.succeeded", built.capability);
			plan = { ...plan, localImages: localImageReadiness(catalog) };
		} catch (error) {
			event("root-capability.failed", {
				operation: "development.local-images.build",
				generation: catalog.generation,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
	if (!plan.localImages.ready) {
		setSetting("stagedGeneration", catalog.generation);
		event("update.postponed", {
			generation: catalog.generation,
			reason: plan.localImages.reason,
			requiredLocalImages: plan.localImages.required,
		});
		return {
			state: "postponed",
			reason: plan.localImages.reason,
			staged: true,
			generation: catalog.generation,
			requiredLocalImages: plan.localImages.required,
			next: setting("automaticInvocation", false)
				? "The manager will retry the catalog-authorized build after backoff."
				: "Run treeai local-build plan --source PATH, then treeai local-build build --source PATH.",
		};
	}
	ensureManagedRuntime();
	if (!packageOnly) await acquireImages(catalog);
	if (!packageOnly && activeWork(config.products)) {
		setSetting("stagedGeneration", catalog.generation);
		event("update.postponed", {
			generation: catalog.generation,
			reason: "active_work",
		});
		return {
			state: "postponed",
			reason: "active_work",
			staged: true,
			generation: catalog.generation,
		};
	}
	if (setting("updateCancelled", false)) {
		setSetting("updateCancelled", false);
		event("update.cancelled", { generation: catalog.generation });
		return { state: "cancelled", generation: catalog.generation };
	}
	const snapshotPath = snapshot(catalog);
	setSetting("installStarted", true);
	try {
		event("update.installing", { generation: catalog.generation });
		command("apt-get", [...aptOptions(config.updates.channel), "--no-remove", "--no-install-recommends", "install", "-y", ...packages]);
		const platform = packageOnly ? undefined : await reconcilePlatform();
		health();
		const path = receipt(catalog, packages, "known-good");
		setSetting("knownGoodGeneration", catalog.generation);
		setSetting("stagedGeneration", null);
		setSetting("platformState", "ready");
		event("update.committed", {
			generation: catalog.generation,
			receipt: path,
		});
		return {
			state: "succeeded",
			generation: catalog.generation,
			packageOnly,
			receipt: path,
			snapshot: snapshotPath,
			platform,
		};
	} catch (error) {
		setSetting("platformState", "degraded");
		event("update.degraded", {
			generation: catalog.generation,
			snapshot: snapshotPath,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		setSetting("installStarted", false);
	}
}
export function setChannel(channel: unknown, approveDowngrade = false) {
	if (channel !== "stable" && channel !== "development") throw new Error("Channel must be stable or development.");
	const current = configuration(),
		source = `/etc/apt/sources.list.d/treeseed-ai-${channel}.sources`,
		other = `/etc/apt/sources.list.d/treeseed-ai-${channel === "stable" ? "development" : "stable"}.sources`,
		template = `/usr/share/treeseed-ai/bootstrap/${channel}.sources`,
		prior = existsSync(source) ? readFileSync(source) : undefined;
	try {
		const content = readFileSync(template, "utf8").replaceAll("/etc/apt/keyrings/treeseed-ai-bootstrap-", "/usr/share/keyrings/treeseed-ai-");
		writeFileSync(source, content, { mode: 0o644 });
		command("apt-get", [...aptOptions(channel), "update"]);
		const installed = spawnSync("dpkg-query", ["-W", "-f=${Version}", "treeseed-ai-manager"], { encoding: "utf8" }).stdout.trim(),
			policy = command("apt-cache", [...aptOptions(channel), "policy", "treeseed-ai-manager"]),
			candidate = policy.match(/Candidate:\s+(\S+)/u)?.[1];
		if (installed && candidate && spawnSync("dpkg", ["--compare-versions", candidate, "lt", installed]).status === 0 && !approveDowngrade) throw new Error(`Switching to ${channel} would downgrade ${installed} to ${candidate}; explicit approval is required.`);
		rmSync(other, { force: true });
		current.updates.channel = channel;
		current.updates.policy = channel === "development" ? "continuous" : "scheduled";
		current.updates.pollSeconds = channel === "development" ? 60 : 86400;
		current.generation += 1;
		current.provenance.generator = "treeai-manager-channel";
		writeFileSync(paths.configuration, JSON.stringify(finalizeConfiguration(current), null, 2), { mode: 0o600 });
		securePlatformConfiguration();
		try {
			execFileSync("systemctl", [
				"disable",
				"--now",
				`treeseed-ai-manager-${channel === "stable" ? "development" : "stable"}.timer`,
			]);
			execFileSync("systemctl", [
				"enable",
				`treeseed-ai-manager-${channel}.timer`,
			]);
		} catch (error) {
			throw new Error(
				`Cannot configure the ${channel} update timer: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		setSetting("channel", channel);
		event("update.channel", { channel, installed, candidate });
		return { channel, installed, candidate };
	} catch (error) {
		if (prior) writeFileSync(source, prior);
		else rmSync(source, { force: true });
		throw error;
	}
}
export function activateChannelTimer(channel: unknown) {
	if (channel !== "stable" && channel !== "development")
		throw new Error("Channel must be stable or development.");
	execFileSync("systemctl", [
		"restart",
		"--no-block",
		`treeseed-ai-manager-${channel}.timer`,
	]);
}
export function updateStatus() {
	const config = configuration();
	const stagedGeneration = setting<number | null>("stagedGeneration", null),
		stagedPath = stagedGeneration ? join(paths.state, `staged-catalog-${stagedGeneration}.json`) : undefined,
		stagedCatalog = stagedPath && existsSync(stagedPath) ? validateCatalog(JSON.parse(readFileSync(stagedPath, "utf8"))) : undefined,
		localImages = stagedCatalog ? (managementOnly(stagedCatalog) ? { ready: true, required: [], images: new Map<string, string>() } : localImageReadiness(stagedCatalog, { inspect: false })) : undefined;
	const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
		[hour, minute] = config.updates.maintenanceWindow.localTime.split(":").map(Number),
		next = new Date();
	next.setHours(hour!, minute!, 0, 0);
	while (next <= new Date() || days[next.getDay()] !== config.updates.maintenanceWindow.weekday) next.setDate(next.getDate() + 1);
	return {
		channel: config.updates.channel,
		policy: config.updates.policy,
		pollSeconds: config.updates.pollSeconds,
		lastMetadataCheck: setting("lastMetadataCheck", null),
		catalogGeneration: setting("catalogGeneration", 0),
		knownGoodGeneration: setting("knownGoodGeneration", 0),
		stagedGeneration,
		imagePolicy: stagedCatalog?.imagePolicy ?? null,
		localImages: localImages ? { ready: localImages.ready, reason: localImages.reason ?? null, required: localImages.required } : null,
		nextApplyWindow: config.updates.channel === "stable" ? { startsAt: next.toISOString(), jitterMinutes: config.updates.maintenanceWindow.jitterMinutes } : "after-safe-drain",
		paused: setting("updatesPaused", false),
		platformState: setting("platformState", "ready"),
		retry: setting("retry", { failures: 0, nextAttempt: null }),
	};
}
export async function restoreGeneration(value: unknown) {
	if (!Number.isInteger(value) || Number(value) < 1) throw new Error("A positive catalog generation is required.");
	const generation = Number(value),
		receiptPath = join(paths.state, `generation-${generation}.json`);
	if (!existsSync(receiptPath)) throw new Error(`Generation ${generation} is not installed.`);
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
		mode?: string;
		rollback?: { compatible?: boolean };
		knownGood?: string;
	};
	if (!receipt.rollback?.compatible || !receipt.knownGood || !existsSync(receipt.knownGood)) throw new Error("Generation does not have a compatible recovery snapshot.");
	copyFileSync(join(receipt.knownGood, "platform.json"), paths.configuration);
	securePlatformConfiguration();
	for (const product of ["inference", "training", "lab"]) {
		const source = join(receipt.knownGood, `${product}.environment`),
			target = `/etc/treeseed-ai/${product}/environment`;
		if (existsSync(source)) copyFileSync(source, target);
	}
	if (receipt.mode === "awake" || receipt.mode === "sleep") persistMode(receipt.mode);
	try {
		const platform = await reconcilePlatform();
		setSetting("knownGoodGeneration", generation);
		setSetting("platformState", "ready");
		event("recovery.restored", { generation });
		return { generation, state: "restored", platform };
	} catch (error) {
		setSetting("platformState", "degraded");
		event("recovery.failed", {
			generation,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
