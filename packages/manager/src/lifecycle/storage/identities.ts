import { createHash } from "node:crypto";

const prefixes = {
	inference: "inf",
	training: "trn",
	trainingImport: "xfer",
} as const;

export type ObjectStoreIdentityPurpose = keyof typeof prefixes;

export function secretGeneration(value: string) {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function objectStoreAccessId(
	purpose: ObjectStoreIdentityPurpose,
	secret: string,
) {
	if (!secret) throw new Error("Object-store credential material is missing.");
	const generation = createHash("sha256")
		.update(`${purpose}\0${secret}`)
		.digest("hex")
		.slice(0, 12);
	return `${prefixes[purpose]}-${generation}`;
}
