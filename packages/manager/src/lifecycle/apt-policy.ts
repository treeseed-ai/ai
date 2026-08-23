import type { ReleaseCatalog } from "../core/catalog.js";

export function assertCatalogedSimulation(
	simulation: string,
	catalog: ReleaseCatalog,
) {
	if (/^Remv /mu.test(simulation) || /DOWNGRADED/mu.test(simulation))
		throw new Error("APT simulation proposed removal or downgrade.");
	const cataloged = new Set(catalog.packages.map((item) => item.name)),
		uncataloged = [...simulation.matchAll(/^Inst\s+(treeseed-ai\S*)/gmu)]
			.map((match) => match[1]!)
			.filter((name) => !cataloged.has(name));
	if (uncataloged.length)
		throw new Error(
			`APT simulation proposed uncataloged packages: ${[...new Set(uncataloged)].join(", ")}.`,
		);
}
