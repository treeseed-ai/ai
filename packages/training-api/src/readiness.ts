const objectStoreCodes = {
	InvalidAccessKeyId: "object_store_identity_invalid",
	SignatureDoesNotMatch: "object_store_signature_invalid",
	AccessDenied: "object_store_access_denied",
	NoSuchBucket: "object_store_bucket_missing",
} as const;

export class DependencyReadinessError extends Error {
	constructor(readonly code: string) {
		super("A training API dependency is unavailable.");
	}
}

export function objectStoreReadinessError(error: unknown) {
	const name = error instanceof Error ? error.name : "";
	return new DependencyReadinessError(
		objectStoreCodes[name as keyof typeof objectStoreCodes] ??
			"object_store_unavailable",
	);
}

export function readinessEnvelope(error: unknown) {
	return {
		ok: false,
		error: {
			code:
				error instanceof DependencyReadinessError
					? error.code
					: "dependency_unavailable",
			message: "A training API dependency is unavailable.",
		},
	};
}
