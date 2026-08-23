import { randomBytes, scryptSync } from "node:crypto";

export function hashHermesPassword(password: string) {
	const salt = randomBytes(16);
	return `scrypt$16384$8$1$${salt.toString("base64")}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64")}`;
}
