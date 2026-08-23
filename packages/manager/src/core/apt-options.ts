export function aptOptions(channel: "stable" | "development") {
	return [
		"-o", `Dir::Etc::sourcelist=/etc/apt/sources.list.d/treeseed-ai-${channel}.sources`,
		"-o", "Dir::Etc::sourceparts=-",
		"-o", "APT::Get::List-Cleanup=0",
		...(channel === "development" ? [
			"-o", "Acquire::http::No-Cache=true",
			"-o", "Acquire::http::Max-Age=0",
			"-o", "Acquire::https::No-Cache=true",
			"-o", "Acquire::https::Max-Age=0",
		] : []),
	];
}
