import { createHash } from "node:crypto";

export type UpdateChannel = "stable" | "development";
export type UpdatePolicy = "scheduled" | "continuous" | "staged" | "manual";
export interface SecretReference {
	provider: "file" | "systemd-credential" | "vault" | "aws-secrets-manager";
	reference: string;
}
export interface PlatformConfiguration {
	schemaVersion: "treeai.platform/v1";
	configurationId: string;
	generation: number;
	hostRole: "factory" | "inference" | "training" | "lab" | "custom";
	products: Array<"host-runtime" | "inference" | "training" | "lab">;
	imageSource: "registry" | "local-build";
	runtime: { management: "managed" | "external" };
	state: {
		postgresql: "bundled" | "external";
		objectStorage: "bundled" | "external";
	};
	lab?: {
		webui: {
			authentication: "disabled" | "local-users";
			browserUrl: string;
			binding: string;
		};
		hermes?: {
			dashboardUrl: string;
			binding: string;
			authentication: "local-password";
		};
	};
	network: {
		bindings: Record<string, string>;
		hostnames: string[];
		sans: string[];
		trustedLanCidrs: string[];
	};
	updates: {
		channel: UpdateChannel;
		policy: UpdatePolicy;
		pollSeconds: number;
		maintenanceWindow: {
			weekday: string;
			localTime: string;
			jitterMinutes: number;
		};
		drain: { inferenceSeconds: number; trainingSeconds: number };
	};
	secrets: Record<string, SecretReference>;
	provenance: {
		generator: string;
		generatedAt: string;
		configurationDigest: string;
	};
}
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, sorted(item)]),
		);
	return value;
}
function assertRelationships(value: PlatformConfiguration) {
	if (
		!["factory", "inference", "training", "lab", "custom"].includes(
			value.hostRole,
		)
	)
		throw new Error("Invalid hostRole.");
	if (
		!value.runtime ||
		!["managed", "external"].includes(value.runtime.management)
	)
		throw new Error("Invalid runtime management.");
	if (
		!value.state ||
		!["bundled", "external"].includes(value.state.postgresql) ||
		!["bundled", "external"].includes(value.state.objectStorage)
	)
		throw new Error("Invalid state profile.");
	if (
		!value.network ||
		typeof value.network.bindings !== "object" ||
		!Array.isArray(value.network.hostnames) ||
		!Array.isArray(value.network.sans) ||
		!Array.isArray(value.network.trustedLanCidrs)
	)
		throw new Error("Invalid network configuration.");
	if (
		!value.updates?.maintenanceWindow ||
		!/^([01]\d|2[0-3]):[0-5]\d$/u.test(
			value.updates.maintenanceWindow.localTime,
		) ||
		value.updates.maintenanceWindow.jitterMinutes < 0 ||
		value.updates.maintenanceWindow.jitterMinutes > 30 ||
		!value.updates.drain ||
		value.updates.drain.inferenceSeconds < 1 ||
		value.updates.drain.trainingSeconds < 1
	)
		throw new Error("Invalid maintenance or drain policy.");
	if (new Set(value.products).size !== value.products.length)
		throw new Error("Configured products must be unique.");
	if (
		value.runtime.management === "managed" &&
		!value.products.includes("host-runtime")
	)
		throw new Error("Managed runtime requires the host-runtime product.");
	if (
		value.products.includes("lab") &&
		(!value.products.includes("inference") ||
			!value.products.includes("training"))
	)
		throw new Error("The lab product requires inference and training.");
	if (value.lab) {
		const webui = value.lab.webui;
		if (
			!webui ||
			!["disabled", "local-users"].includes(webui.authentication) ||
			!/^https:\/\//u.test(webui.browserUrl) ||
			!/^.+:\d{1,5}$/u.test(webui.binding)
		)
			throw new Error("Invalid lab Open WebUI configuration.");
		if (
			webui.authentication === "disabled" &&
			(webui.binding !== "127.0.0.1:443" ||
				new URL(webui.browserUrl).hostname !== "chat.treeai.localhost")
		)
			throw new Error(
				"Authentication-disabled Open WebUI requires https://chat.treeai.localhost on 127.0.0.1:443.",
			);
		const hermes = value.lab.hermes;
		if (
			hermes &&
			(hermes.authentication !== "local-password" ||
				!/^https:\/\//u.test(hermes.dashboardUrl) ||
				hermes.binding !== "127.0.0.1:443" ||
				new URL(hermes.dashboardUrl).hostname !== "hermes.treeai.localhost")
		)
			throw new Error(
				"The Hermes dashboard requires password authentication at https://hermes.treeai.localhost on 127.0.0.1:443.",
			);
	}
}
export function canonicalJson(value: unknown) {
	return `${JSON.stringify(sorted(value))}\n`;
}
export function configurationDigest(value: PlatformConfiguration) {
	assertRelationships(value);
	const copy = structuredClone(value);
	copy.provenance.configurationDigest = "";
	return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}
export function finalizeConfiguration(value: PlatformConfiguration) {
	const copy = structuredClone(value);
	copy.provenance.configurationDigest = configurationDigest(copy);
	return copy;
}
export function validatePlatformConfiguration(
	input: unknown,
): PlatformConfiguration {
	if (!input || typeof input !== "object")
		throw new Error("Configuration must be an object.");
	const value = input as Partial<PlatformConfiguration>;
	if (value.schemaVersion !== "treeai.platform/v1")
		throw new Error("Unsupported platform schema.");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/u.test(value.configurationId ?? ""))
		throw new Error("Invalid configurationId.");
	if (!Number.isInteger(value.generation) || Number(value.generation) < 1)
		throw new Error("generation must be a positive integer.");
	if (
		!Array.isArray(value.products) ||
		value.products.some(
			(item) =>
				!["host-runtime", "inference", "training", "lab"].includes(item),
		)
	)
		throw new Error("Invalid products.");
	if (!["registry", "local-build"].includes(value.imageSource ?? ""))
		throw new Error("Invalid imageSource.");
	const updates = value.updates;
	if (
		!updates ||
		!["stable", "development"].includes(updates.channel) ||
		!["scheduled", "continuous", "staged", "manual"].includes(updates.policy) ||
		!Number.isInteger(updates.pollSeconds) ||
		updates.pollSeconds < 60
	)
		throw new Error("Invalid update policy.");
	if (
		updates.channel === "development" &&
		updates.policy === "continuous" &&
		updates.pollSeconds !== 60
	)
		throw new Error("Continuous development polling must be 60 seconds.");
	for (const [name, secret] of Object.entries(value.secrets ?? {})) {
		if (
			!secret ||
			!["file", "systemd-credential", "vault", "aws-secrets-manager"].includes(
				secret.provider,
			) ||
			!secret.reference
		)
			throw new Error(`Invalid secret reference ${name}.`);
		if (
			/(?:password|secret|token|key)\s*=/iu.test(secret.reference) ||
			/^ak_[^_]+_[A-Za-z0-9_-]{16,}$/u.test(secret.reference)
		)
			throw new Error(
				`Secret ${name} must be a provider reference, not a credential value.`,
			);
	}
	if (!value.provenance?.generator || !value.provenance.generatedAt)
		throw new Error("Missing generator provenance.");
	const finalized = value as PlatformConfiguration;
	if (
		finalized.provenance.configurationDigest &&
		finalized.provenance.configurationDigest !== "0".repeat(64) &&
		finalized.provenance.configurationDigest !== configurationDigest(finalized)
	)
		throw new Error("Configuration digest does not match canonical content.");
	return finalized;
}
