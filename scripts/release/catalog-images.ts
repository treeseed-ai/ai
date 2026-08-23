type ManifestImage = { repository: string; digest: string; buildIdentity: string };
type PlannedImage = { action: "built" | "reused"; buildIdentity: string };

export function catalogImageEntries(
	roles: string[],
	manifest: Record<string, ManifestImage> | undefined,
	plan: Record<string, PlannedImage> | undefined,
	generation: number,
	forcePackageOnly: boolean,
	dockerNamespace: string,
) {
	return roles.flatMap((role, index) => {
		const image = manifest?.[role], planned = plan?.[role], digest = image?.digest,
			published = /^sha256:[a-f0-9]{64}$/u.test(digest ?? ""),
			local = planned?.action === "built" && !forcePackageOnly;
		if (!published && !local) return [];
		return [{
			role,
			repository: image?.repository ?? `${dockerNamespace}/${role}`,
			digest: published ? digest! : `sha256:${"0".repeat(64)}`,
			...(!published ? { localBuildOnly: true } : {}),
			buildIdentity: local ? planned!.buildIdentity : image!.buildIdentity,
			consumers: [role.startsWith("lab-") || role === "hermes-agent" ? "lab" : ["axolotl-worker", "marker-worker", "artifact-worker"].includes(role) ? "training" : role.split("-")[0]],
			restartImpact: role,
			firstBuildGeneration: generation + index,
		}];
	});
}
