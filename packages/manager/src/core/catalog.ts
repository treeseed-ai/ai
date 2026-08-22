import { readFileSync } from "node:fs";
import { paths } from "./paths.js";
export interface CatalogPackage {
	name: string;
	version: string;
	architecture: "amd64" | "all";
	origin: string;
	order: number;
}
export interface CatalogImage {
	role: string;
	digest: string;
	consumers: string[];
	restartImpact: string;
	firstBuildGeneration: number;
}
export interface RuntimeImage {
	id: string;
	reference: string;
	digest: string;
	consumers: string[];
	restartImpact: string;
}
export interface ReleaseCatalog {
	schemaVersion: "treeai.release-catalog/v1";
	release: string;
	channel: "stable" | "development";
	generation: number;
	compatibilityId: string;
	classification: "automatic" | "manual" | "breaking" | "blocked";
	automatic: boolean;
	suite: string;
	signingKeyFingerprint: string;
	platform: {
		architecture: string;
		operatingSystems: string[];
		manager: string;
		nodeRuntime: string;
		nvidiaDriver: string;
	};
	packages: CatalogPackage[];
	images: CatalogImage[];
	runtimeImages: RuntimeImage[];
	composeGeneration: number;
	configurationGeneration: number;
	migrations: Array<{
		id: string;
		product: string;
		order: number;
		backupRequired: boolean;
	}>;
	gates: string[];
	rollback: { compatible: boolean; requiresBackup: boolean };
	evidence: {
		cosignIssuer: string;
		cosignIdentity: string;
		githubRelease: string;
		sbomAssetPattern: string;
		vulnerabilityAssetPattern: string;
	};
}
export function validateCatalog(input: unknown): ReleaseCatalog {
	if (!input || typeof input !== "object")
		throw new Error("Catalog must be an object.");
	const value = input as Partial<ReleaseCatalog>;
	if (
		value.schemaVersion !== "treeai.release-catalog/v1" ||
		!Number.isInteger(value.generation) ||
		Number(value.generation) < 1
	)
		throw new Error("Invalid release catalog.");
	if (
		!["stable", "development"].includes(value.channel ?? "") ||
		value.suite !== value.channel
	)
		throw new Error("Catalog suite/channel mismatch.");
	if (!/^[A-F0-9]{40}$/u.test(value.signingKeyFingerprint ?? ""))
		throw new Error("Invalid catalog signing key identity.");
	if (
		!Array.isArray(value.packages) ||
		value.packages.some(
			(item) =>
				!item.name.startsWith("treeseed-ai") ||
				!item.version ||
				(item.architecture !== "amd64" && item.architecture !== "all") ||
				item.origin !== "TreeSeed AI",
		)
	)
		throw new Error("Catalog contains an invalid package.");
	if (
		!Array.isArray(value.images) ||
		value.images.some((item) => !/^sha256:[a-f0-9]{64}$/u.test(item.digest))
	)
		throw new Error("Catalog contains an invalid image digest.");
	if (
		!Array.isArray(value.runtimeImages) ||
		value.runtimeImages.some(
			(item) =>
				!/^sha256:[a-f0-9]{64}$/u.test(item.digest) ||
				!item.reference.endsWith(`@${item.digest}`),
		)
	)
		throw new Error("Catalog contains an invalid runtime image.");
	return value as ReleaseCatalog;
}
export function readCatalog(path = paths.catalog) {
	return validateCatalog(JSON.parse(readFileSync(path, "utf8")));
}
