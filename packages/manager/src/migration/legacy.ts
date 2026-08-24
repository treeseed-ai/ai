import type { PlatformConfiguration } from "@ai-platform/common";

export function assertLegacyServiceEnvironment(
	product: string,
	content: string,
) {
	for (const name of [
		"POSTGRES_PASSWORD",
		"S3_SECRET_KEY",
		"MINIO_ROOT_PASSWORD",
	])
		if (!new RegExp(`^${name}=.+$`, "mu").test(content))
			throw new Error(
				`Legacy ${product} environment does not contain ${name}.`,
			);
}

export function legacyPlatformConfiguration(input: {
	legacy04: boolean;
	deploymentMode?: string;
	hostname: string;
	generatedAt?: string;
}): PlatformConfiguration {
	return {
		schemaVersion: "treeai.platform/v1",
		configurationId: "migrated-local-factory",
		generation: 1,
		hostRole: "factory",
		products: ["host-runtime", "inference", "training", "lab"],
		imageSource:
			input.legacy04 || input.deploymentMode === "published"
				? "registry"
				: "local-build",
		runtime: { management: "managed" },
		state: { postgresql: "bundled", objectStorage: "bundled" },
		network: {
			bindings: {
				manager: "0.0.0.0:4790",
				inference: "0.0.0.0:4770",
				openai: "0.0.0.0:4771",
				training: "0.0.0.0:4780",
				lab: "0.0.0.0:4793",
			},
			hostnames: [input.hostname],
			sans: [input.hostname, "localhost", "127.0.0.1"],
			trustedLanCidrs: [],
		},
		updates: {
			channel: "stable",
			policy: "manual",
			pollSeconds: 86400,
			maintenanceWindow: {
				weekday: "sunday",
				localTime: "03:00",
				jitterMinutes: 30,
			},
			drain: { inferenceSeconds: 120, trainingSeconds: 300 },
		},
		secrets: {},
		provenance: {
			generator: input.legacy04
				? "treeai-migrate-0.4/0.10.0"
				: "treeai-migrate-0.5/0.10.0",
			generatedAt: input.generatedAt ?? new Date().toISOString(),
			configurationDigest: "",
		},
	};
}
