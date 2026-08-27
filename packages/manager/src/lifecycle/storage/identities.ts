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

export function objectStoreAccessIds(migrated:boolean,secrets:{inference:string;training:string;trainingImport:string}) {
	return {inference:migrated?"inference":objectStoreAccessId("inference",secrets.inference),training:migrated?"training":objectStoreAccessId("training",secrets.training),trainingImport:objectStoreAccessId("trainingImport",secrets.trainingImport)};
}
