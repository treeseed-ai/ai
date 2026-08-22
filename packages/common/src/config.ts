export function requiredEnv(name: string, env = process.env) {
	const value = env[name]?.trim();
	if (!value) throw new Error(`Required environment variable ${name} is missing.`);
	return value;
}

export function numberEnv(name: string, fallback: number, env = process.env) {
	const value = Number(env[name] ?? fallback);
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
	return value;
}

export function parseBootstrapKeys(value = process.env.AI_API_KEYS ?? '[]') {
	const records = JSON.parse(value) as Array<{ id: string; hash: string; scopes: string[]; revoked?: boolean }>;
	return records.map((entry) => ({ ...entry, revoked: entry.revoked ?? false }));
}
