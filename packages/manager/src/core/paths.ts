export const paths = {
	state: process.env.TREEAI_MANAGER_STATE ?? "/var/lib/treeseed-ai/manager",
	database:
		process.env.TREEAI_MANAGER_DB ??
		"/var/lib/treeseed-ai/manager/lifecycle.db",
	configuration:
		process.env.TREEAI_PLATFORM_CONFIG ?? "/etc/treeseed-ai/platform.json",
	catalog:
		process.env.TREEAI_RELEASE_CATALOG ??
		"/usr/share/treeseed-ai/release/catalog.json",
	socket:
		process.env.TREEAI_MANAGER_SOCKET ??
		"/run/treeseed-ai/manager/control.sock",
	apiKeys:
		process.env.TREEAI_MANAGER_API_KEYS_FILE ??
		"/etc/treeseed-ai/manager/api-keys.json",
	mode:
		process.env.TREEAI_MODE_STATE ?? "/var/lib/treeseed-ai/platform/mode.json",
	localBuildReceipt:
		process.env.TREEAI_LOCAL_BUILD_RECEIPT ??
		"/var/lib/treeseed-ai/manager/local-build-receipt.json",
};
