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
	const explicit = String(record.Health ?? "").toLowerCase(),
		status = String(record.Status ?? "").toLowerCase(),
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
			name: String(record.Service ?? record.Name ?? "unknown"),
			state: String(record.State ?? "unknown").toLowerCase(),
			health: health(record),
			image: String(record.Image ?? "unknown"),
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
