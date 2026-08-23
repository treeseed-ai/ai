import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson, finalizeConfiguration, validatePlatformConfiguration, type PlatformConfiguration } from "../packages/common/src/platform/index.js";
import { catalogImageEntries } from "./release/catalog-images.js";
type Release = {
	version: string;
	debianVersion: string;
	sourceDateEpoch: number;
	products: string[];
	images: string[];
};
const root = process.cwd(),
	release = JSON.parse(readFileSync(resolve(root, "release/manifest.json"), "utf8")) as Release,
	artifacts = resolve(root, ".artifacts");
release.debianVersion = process.env.TREEAI_DEBIAN_VERSION ?? release.debianVersion;
process.env.SOURCE_DATE_EPOCH ??= String(release.sourceDateEpoch);
mkdirSync(artifacts, { recursive: true });
function directory(base: string, ...paths: string[]) {
	for (const path of paths) mkdirSync(resolve(base, path), { recursive: true });
}
function packageName(product: string) {
	return product === "bootstrap" ? "treeseed-ai" : `treeseed-ai-${product}`;
}
function normalize(path: string) {
	if (path.endsWith("_stage") && path.includes("treeseed-ai-manager_")) {
		directory(path, "usr/lib/treeseed-ai/manager/factory");
		for (const file of ["compose.yml", "Caddyfile"]) copyFileSync(resolve(root, `deploy/factory/${file}`), resolve(path, `usr/lib/treeseed-ai/manager/factory/${file}`));
	}
	const stat = lstatSync(path);
	if (stat.isDirectory()) for (const name of readdirSync(path)) normalize(resolve(path, name));
	if (!stat.isSymbolicLink()) chmodSync(path, stat.mode & ~0o022);
}
function control(product: string, base: string, version = release.debianVersion) {
	const source = resolve(root, `debian/${product}`),
		target = resolve(base, "DEBIAN");
	directory(base, "DEBIAN");
	for (const file of ["control", "postinst", "prerm"])
		if (existsSync(resolve(source, file))) {
			let value = readFileSync(resolve(source, file), "utf8").replace(/^Version: .*$/mu, `Version: ${version}`);
			writeFileSync(resolve(target, file), value);
			if (file !== "control") chmodSync(resolve(target, file), 0o755);
		}
}
function descriptor(names: string[], base: string) {
	directory(base, "usr/lib/treeseed-ai/commands.d");
	for (const name of names) copyFileSync(resolve(root, `deploy/commands/${name}.json`), resolve(base, `usr/lib/treeseed-ai/commands.d/${name}.json`));
}
function finish(product: string, base: string, version = release.debianVersion) {
	normalize(base);
	if (process.env.TREEAI_DEBHELPER_STAGE === "1") {
		const target = resolve(root, "debian", packageName(product));
		rmSync(target, { recursive: true, force: true });
		rmSync(resolve(base, "DEBIAN"), { recursive: true, force: true });
		cpSync(base, target, { recursive: true });
		for (const script of ["postinst", "prerm"]) if (existsSync(resolve(root, `debian/${product}/${script}`))) copyFileSync(resolve(root, `debian/${product}/${script}`), resolve(root, `debian/${packageName(product)}.${script}`));
		rmSync(base, { recursive: true, force: true });
		return target;
	}
	const architecture = readFileSync(resolve(base, "DEBIAN/control"), "utf8").match(/^Architecture:\s+(\S+)/mu)?.[1] ?? "amd64",
		target = resolve(artifacts, `${packageName(product)}_${version}_${architecture}.deb`);
	rmSync(target, { force: true });
	execFileSync("dpkg-deb", ["--build", "--root-owner-group", base, target], {
		stdio: "inherit",
	});
	rmSync(base, { recursive: true, force: true });
	return target;
}
function dearmor(source: string, target: string) {
	if (!existsSync(source)) throw new Error(`APT public key is missing: ${source}`);
	execFileSync("gpg", ["--batch", "--yes", "--dearmor", "--output", target, source]);
}
function bootstrap(base: string, configured?: PlatformConfiguration, version = release.debianVersion, temporary?: unknown) {
	directory(base, "usr/lib/treeseed-ai/bootstrap", "usr/share/treeseed-ai/bootstrap/keyrings", "usr/lib/systemd/system", "usr/share/doc/treeseed-ai");
	copyFileSync(resolve(root, "scripts/bootstrap/bootstrap.sh"), resolve(base, "usr/lib/treeseed-ai/bootstrap/bootstrap.sh"));
	chmodSync(resolve(base, "usr/lib/treeseed-ai/bootstrap/bootstrap.sh"), 0o755);
	copyFileSync(resolve(root, "scripts/bootstrap/migrate-0.4.sh"), resolve(base, "usr/lib/treeseed-ai/bootstrap/migrate-0.4.sh"));
	chmodSync(resolve(base, "usr/lib/treeseed-ai/bootstrap/migrate-0.4.sh"), 0o755);
	for (const name of ["stable.sources", "development.sources"]) copyFileSync(resolve(root, `deploy/bootstrap/${name}`), resolve(base, `usr/share/treeseed-ai/bootstrap/${name}`));
	copyFileSync(resolve(root, "deploy/bootstrap/preferences"), resolve(base, "usr/share/treeseed-ai/bootstrap/preferences"));
	copyFileSync(resolve(root, "systemd/treeseed-ai-bootstrap.service"), resolve(base, "usr/lib/systemd/system/treeseed-ai-bootstrap.service"));
	copyFileSync(resolve(root, "config/platform.schema.json"), resolve(base, "usr/share/treeseed-ai/bootstrap/platform.schema.json"));
	const configuration = finalizeConfiguration(configured ?? JSON.parse(readFileSync(resolve(root, "config/platform.default.json"), "utf8")));
	writeFileSync(resolve(base, "usr/share/treeseed-ai/bootstrap/platform.json"), canonicalJson(configuration), { mode: 0o600 });
	if (configured) writeFileSync(resolve(base, "usr/share/treeseed-ai/bootstrap/configured-seed"), `${configuration.configurationId}\n`);
	if (temporary) writeFileSync(resolve(base, "usr/share/treeseed-ai/bootstrap/temporary-credentials.json"), canonicalJson(temporary), { mode: 0o600 });
	dearmor(resolve(root, "release/apt/treeseed-ai-archive-keyring.asc"), resolve(base, "usr/share/treeseed-ai/bootstrap/keyrings/treeseed-ai-bootstrap-archive-keyring.gpg"));
	dearmor(resolve(root, "release/apt-development/treeseed-ai-development-archive-keyring.asc"), resolve(base, "usr/share/treeseed-ai/bootstrap/keyrings/treeseed-ai-bootstrap-development-archive-keyring.gpg"));
	copyFileSync(resolve(root, "debian/copyright"), resolve(base, "usr/share/doc/treeseed-ai/copyright"));
	writeFileSync(resolve(base, "usr/share/doc/treeseed-ai/changelog.Debian.gz"), gzipSync(readFileSync(resolve(root, "debian/changelog")), { level: 9 }));
	return finish("bootstrap", base, version);
}
function runtime(base: string) {
	const manifest = JSON.parse(readFileSync(resolve(root, "release/host-js-runtime.json"), "utf8")) as { version: string; url: string; sha256: string },
		cache = resolve(root, ".cache", basename(manifest.url));
	directory(base, "usr/lib/treeseed-ai/runtime");
	if (!existsSync(cache)) {
		directory(root, ".cache");
		execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--output", cache, manifest.url], { stdio: "inherit" });
	}
	const digest = createHash("sha256").update(readFileSync(cache)).digest("hex");
	if (digest !== manifest.sha256) throw new Error("Private Node runtime checksum mismatch.");
	execFileSync("tar", ["-xJf", cache, "--strip-components=1", "-C", resolve(base, "usr/lib/treeseed-ai/runtime")]);
	for (const path of ["CHANGELOG.md", "README.md", "include", "lib", "share", "bin/corepack", "bin/npm", "bin/npx"]) rmSync(resolve(base, "usr/lib/treeseed-ai/runtime", path), { recursive: true, force: true });
	return finish("host-js-runtime", base);
}
function catalog(base: string) {
	directory(base, "usr/share/treeseed-ai/release");
	const catalogSource = process.env.TREEAI_BASE_CATALOG || resolve(root, "release/catalog.json"),
		value = JSON.parse(readFileSync(catalogSource, "utf8")) as Record<string, unknown>,
		catalogProducts = process.env.TREEAI_CATALOG_PACKAGE_SET === "management"
			? release.products.filter((product) => ["archive-keyring", "development-archive-keyring", "host-js-runtime", "manager", "cli", "release-catalog"].includes(product))
			: release.products,
		packages = catalogProducts.map((product, index) => ({
			name: packageName(product),
			version: release.debianVersion,
			architecture: ["archive-keyring", "development-archive-keyring", "release-catalog"].includes(product) ? "all" : "amd64",
			origin: "TreeSeed AI",
			order: index,
		})),
		imageManifest = JSON.parse(readFileSync(process.env.TREEAI_IMAGE_MANIFEST ?? resolve(root, "release/image-manifest.json"), "utf8")) as { version?: string; images?: Record<string, { repository: string; digest: string; buildIdentity: string }> },
		imagePlanPath = process.env.TREEAI_IMAGE_PLAN,
		imagePlan = imagePlanPath ? JSON.parse(readFileSync(imagePlanPath, "utf8")) as { images?: Record<string, { action: "built" | "reused"; buildIdentity: string }> } : undefined;
	value.release = process.env.TREEAI_RELEASE_VERSION ?? release.version;
	value.channel = process.env.TREEAI_RELEASE_CHANNEL ?? value.channel;
	value.suite = value.channel;
	value.generation = Number(process.env.TREEAI_RELEASE_GENERATION ?? value.generation);
	if (value.channel === "development") {
		value.classification = "automatic";
		value.automatic = true;
		value.signingKeyFingerprint = readFileSync(resolve(root, "release/apt-development/RELEASE_KEY_FINGERPRINT"), "utf8").trim();
	}
	value.packages = packages;
	value.packageSet = process.env.TREEAI_CATALOG_PACKAGE_SET === "management" ? "management" : "all";
	if (process.env.TREEAI_CATALOG_PACKAGE_SET === "management") {
		value.migrations = [];
		value.gates = ["manager-health"];
		value.rollback = { compatible: true, requiresBackup: false };
	}
	const requiredLocalImages = release.images.flatMap((role) => {
		const planned = imagePlan?.images?.[role];
		return planned?.action === "built" ? [{ role, buildIdentity: planned.buildIdentity }] : [];
	});
	if (process.env.TREEAI_FORCE_PACKAGE_ONLY !== "1") {
		value.imagePolicy = {
			mode: requiredLocalImages.length ? "local-images-required" : "package-only",
			productionManifestVersion: imageManifest.version ?? release.version,
			sourceRevision: process.env.TREEAI_SOURCE_REVISION ?? "release-source",
			sourceBundle: process.env.TREEAI_SOURCE_ARCHIVE_URL && process.env.TREEAI_SOURCE_ARCHIVE_SHA256
				? { url: process.env.TREEAI_SOURCE_ARCHIVE_URL, sha256: process.env.TREEAI_SOURCE_ARCHIVE_SHA256, format: "tar.gz" }
				: null,
			requiredLocalImages,
		};
		value.images = catalogImageEntries(release.images, imageManifest.images, imagePlan?.images, Number(value.generation), false, release.dockerNamespace);
	} else if (value.images.length !== release.images.length || value.imagePolicy.mode !== "local-images-required") {
		throw new Error("Package-only publication requires a complete full development catalog base.");
	} else {
		// The installed pre-packageSet manager must also recognize this bridge as
		// image-inert. Image lineage stays complete in `images` and in receipts.
		value.imagePolicy = {
			...value.imagePolicy,
			mode: "package-only",
			sourceBundle: null,
			requiredLocalImages: [],
		};
	}
	writeFileSync(resolve(base, "usr/share/treeseed-ai/release/catalog.json"), JSON.stringify(value, null, 2));
	return finish("release-catalog", base);
}
function build(product: string) {
	if (!release.products.includes(product)) throw new Error(`Unknown product ${product}`);
	const base = resolve(artifacts, `${packageName(product)}_${release.debianVersion}_stage`);
	rmSync(base, { recursive: true, force: true });
	control(product, base);
	if (product === "bootstrap") return bootstrap(base);
	if (product === "archive-keyring" || product === "development-archive-keyring") {
		directory(base, "usr/share/keyrings");
		const development = product.startsWith("development"),
			source = development ? "release/apt-development/treeseed-ai-development-archive-keyring.asc" : "release/apt/treeseed-ai-archive-keyring.asc";
		dearmor(resolve(root, source), resolve(base, `usr/share/keyrings/treeseed-ai-${development ? "development-" : ""}archive-keyring.gpg`));
		return finish(product, base);
	}
	if (product === "host-js-runtime") return runtime(base);
	if (product === "release-catalog") return catalog(base);
	if (product === "factory") return finish(product, base);
	if (product === "cli") {
		directory(base, "usr/bin", "usr/lib/treeseed-ai/cli/dist", "usr/share/treeseed-ai/release");
		cpSync(resolve(root, "packages/cli/dist"), resolve(base, "usr/lib/treeseed-ai/cli/dist"), { recursive: true });
		writeFileSync(resolve(base, "usr/bin/treeai"), '#!/bin/sh\nexec /usr/lib/treeseed-ai/runtime/bin/node /usr/lib/treeseed-ai/cli/dist/treeai.js "$@"\n', { mode: 0o755 });
		copyFileSync(resolve(root, "release/manifest.json"), resolve(base, "usr/share/treeseed-ai/release/manifest.json"));
		return finish(product, base);
	}
	if (product === "manager") {
		directory(base, "usr/lib/treeseed-ai/manager/dist", "usr/lib/systemd/system");
		cpSync(resolve(root, "packages/manager/dist"), resolve(base, "usr/lib/treeseed-ai/manager/dist"), { recursive: true });
		copyFileSync(resolve(root, "scripts/manager/update-helper.sh"), resolve(base, "usr/lib/treeseed-ai/manager/update-helper"));
		chmodSync(resolve(base, "usr/lib/treeseed-ai/manager/update-helper"), 0o755);
		for (const name of ["api.service", "supervisor.service", "reconcile.service", "update.service", "stable.timer", "development.timer", "update-helper.service", "update-helper.timer"]) copyFileSync(resolve(root, `systemd/treeseed-ai-manager-${name}`), resolve(base, `usr/lib/systemd/system/treeseed-ai-manager-${name}`));
		descriptor(["platform", "update", "mode", "config", "recovery", "local-build"], base);
		return finish(product, base);
	}
	descriptor(product === "host-runtime" ? ["host"] : [product], base);
	if (product === "host-runtime") {
		directory(base, "usr/lib/treeseed-ai/host-runtime", "usr/share/treeseed-ai/host-runtime");
		cpSync(resolve(root, "packages/host-runtime/dist"), resolve(base, "usr/lib/treeseed-ai/host-runtime/dist"), { recursive: true });
		rmSync(resolve(base, "usr/lib/treeseed-ai/host-runtime/dist/factory"), {
			recursive: true,
			force: true,
		});
		cpSync(resolve(root, "packages/host-runtime/config"), resolve(base, "usr/lib/treeseed-ai/host-runtime/config"), { recursive: true });
		copyFileSync(resolve(root, "debian/host-runtime/config.example.json"), resolve(base, "usr/share/treeseed-ai/host-runtime/config.example.json"));
		return finish(product, base);
	}
	if (product === "lab") {
		directory(base, "usr/lib/treeseed-ai/lab", "usr/share/treeseed-ai/lab", "usr/lib/systemd/system");
		cpSync(resolve(root, "packages/lab/dist"), resolve(base, "usr/lib/treeseed-ai/lab/dist"), { recursive: true });
		for (const file of ["compose.yml", "Caddyfile"]) copyFileSync(resolve(root, `deploy/lab/${file}`), resolve(base, `usr/lib/treeseed-ai/lab/${file}`));
		copyFileSync(resolve(root, "deploy/lab/lab.env.example"), resolve(base, "usr/share/treeseed-ai/lab/lab.env.example"));
		copyFileSync(resolve(root, "systemd/treeseed-ai-lab.service"), resolve(base, "usr/lib/systemd/system/treeseed-ai-lab.service"));
		return finish(product, base);
	}
	directory(base, `usr/lib/treeseed-ai/${product}`, `usr/share/treeseed-ai/${product}`, "usr/lib/systemd/system");
	for (const file of ["compose.yml", "shared-network.override.yml", "factory.override.yml"]) copyFileSync(resolve(root, `deploy/${product}/${file}`), resolve(base, `usr/lib/treeseed-ai/${product}/${file}`));
	copyFileSync(resolve(root, `deploy/${product}/${product}.env.example`), resolve(base, `usr/share/treeseed-ai/${product}/${product}.env.example`));
	copyFileSync(resolve(root, `systemd/treeseed-ai-${product}.service`), resolve(base, `usr/lib/systemd/system/treeseed-ai-${product}.service`));
	for (const [file, source] of [
		["check-host", "scripts/check-host.sh"],
		["upgrade", "scripts/upgrade.sh"],
	]) {
		copyFileSync(resolve(root, source), resolve(base, `usr/lib/treeseed-ai/${product}/${file}`));
		chmodSync(resolve(base, `usr/lib/treeseed-ai/${product}/${file}`), 0o755);
	}
	return finish(product, base);
}
const requested = process.argv[2] ?? "all";
if (requested === "configured") {
	const source = process.argv[3];
	if (!source) throw new Error("Usage: package-deb.ts configured PLATFORM_JSON");
	const value = validatePlatformConfiguration(JSON.parse(readFileSync(resolve(source), "utf8"))),
		configured = finalizeConfiguration(value),
		temporaryPath = process.env.TREEAI_TEMPORARY_CREDENTIALS_FILE,
		temporary = temporaryPath ? JSON.parse(readFileSync(resolve(temporaryPath), "utf8")) : undefined;
	if (temporary && (!(temporary as { schemaVersion?: string }).schemaVersion || /postgres|s3|registry|proxy/iu.test(JSON.stringify(temporary)))) throw new Error("Temporary credential input may contain only TreeAI-owned bootstrap material.");
	const suffix = createHash("sha256")
			.update(
				canonicalJson({
					configuration: configured,
					temporary: temporary ?? null,
				}),
			)
			.digest("hex")
			.slice(0, 12),
		version = `${release.debianVersion}+cfg.${suffix}`,
		base = resolve(artifacts, `treeseed-ai_${version}_stage`);
	rmSync(base, { recursive: true, force: true });
	control("bootstrap", base, version);
	bootstrap(base, configured, version, temporary);
} else for (const product of requested === "all" ? release.products : [requested]) build(product);
