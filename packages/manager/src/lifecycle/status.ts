export type ProductName = "inference" | "training" | "lab";
export interface ProductStatus {
	product: ProductName;
	state: "ready" | "degraded" | "stopped";
	services: Array<{
		name: string;
		state: string;
		health: "healthy" | "unhealthy" | "starting" | "none";
		image: string;
	}>;
	error?: "status_unavailable";
}
function composeRecords(raw: string) {
	const value = raw.trim();
	if (!value) return [];
	const parsed = value.startsWith("[")
		? JSON.parse(value)
		: value
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
	return (Array.isArray(parsed) ? parsed : [parsed]) as Array<
		Record<string, unknown>
	>;
}
function health(record: Record<string, unknown>) {
	const explicit = String(record.Health ?? record.health ?? "").toLowerCase(),
		status = String(record.Status ?? record.status ?? "").toLowerCase(),
		value = explicit || status;
	if (value.includes("unhealthy")) return "unhealthy" as const;
	if (value.includes("starting")) return "starting" as const;
	if (value.includes("healthy")) return "healthy" as const;
	return "none" as const;
}
export function summarizeComposeStatus(
	product: ProductName,
	raw: string,
): ProductStatus {
	const services = composeRecords(raw)
		.map((record) => ({
			name: String(
				record.Service ?? record.Name ?? record.name ?? "unknown",
			),
			state: String(record.State ?? record.state ?? "unknown").toLowerCase(),
			health: health(record),
			image: String(record.Image ?? record.image ?? "unknown"),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const stopped =
		services.length > 0 &&
		services.every((service) =>
			["exited", "stopped", "created"].includes(service.state),
		);
	const ready =
		services.length > 0 &&
		services.every(
			(service) =>
				service.state === "running" && service.health !== "unhealthy",
		);
	return {
		product,
		state: ready ? "ready" : stopped ? "stopped" : "degraded",
		services,
	};
}
function unavailable(product: ProductName): ProductStatus {
	return {
		product,
		state: "degraded",
		services: [],
		error: "status_unavailable",
	};
}
export function normalizeStoredComponents(value: unknown): ProductStatus[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const stored = value as Record<string, unknown>;
	return (["inference", "training", "lab"] as const).flatMap((product) => {
		const entry = stored[product];
		if (Array.isArray(entry))
			return [summarizeComposeStatus(product, JSON.stringify(entry))];
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		if (!Array.isArray(record.services)) return [unavailable(product)];
		try {
			return [
				summarizeComposeStatus(
					product,
					JSON.stringify(record.services),
				),
			];
		} catch {
			return [unavailable(product)];
		}
	});
}
