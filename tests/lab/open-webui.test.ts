import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	finalizeConfiguration,
	validatePlatformConfiguration,
} from "../../packages/common/src/platform/index.js";
import { assertWebUiAuthenticationDisabled } from "../../packages/manager/src/lifecycle/lab-webui.js";

function defaultConfiguration() {
	return JSON.parse(
		readFileSync("config/platform.default.json", "utf8"),
	) as ReturnType<typeof validatePlatformConfiguration>;
}

describe("Open WebUI local single-user integration", () => {
	it("accepts only the fixed loopback HTTPS configuration when auth is disabled", () => {
		const value = defaultConfiguration();
		value.lab = {
			webui: {
				authentication: "disabled",
				browserUrl: "https://chat.treeai.localhost",
				binding: "127.0.0.1:443",
			},
		};
		expect(
			validatePlatformConfiguration(finalizeConfiguration(value)).lab?.webui
				.authentication,
		).toBe("disabled");
		value.lab.webui.binding = "0.0.0.0:443";
		expect(() =>
			validatePlatformConfiguration(finalizeConfiguration(value)),
		).toThrow(/127\.0\.0\.1:443/u);
	});

	it("routes browser chat through the private experience proxy", () => {
		const raw = readFileSync("deploy/lab/compose.yml", "utf8");
		const compose = YAML.parse(raw);
		expect(compose.services["open-webui"].environment.OPENAI_API_BASE_URLS).toBe(
			"http://experience-proxy:8080/v1",
		);
		expect(compose.services["open-webui"].environment.OPENAI_API_KEYS).toBe(
			"lab-open-webui",
		);
		expect(compose.services["open-webui"].secrets).toBeUndefined();
		expect(compose.services["experience-proxy"].group_add).toEqual([
			"${RUNTIME_GID:?RUNTIME_GID is required}",
		]);
		expect(compose.services.controller.group_add).toEqual([
			"${RUNTIME_GID:?RUNTIME_GID is required}",
			"10001",
		]);
		expect(compose.services.gateway.ports).toBeUndefined();
		expect(compose.services['library-bridge'].networks).toEqual(['lab-private','ai-shared']);
		expect(compose.services['library-bridge'].secrets).toEqual(['training-ingest-key','lab-library-action-key']);
		expect(compose.services['library-bridge'].group_add).toEqual([
			"${RUNTIME_GID:?RUNTIME_GID is required}",
		]);
		expect(compose.services['open-webui'].volumes).toContain('/usr/lib/treeseed-ai/lab/open-webui:/opt/treeai/actions:ro');
		expect(readFileSync('deploy/lab/Caddyfile','utf8')).toContain('reverse_proxy library-bridge:8082');
		const action=readFileSync('deploy/lab/open-webui/treeai_train_library.py','utf8');
		expect(action).toContain('class Action:');
		const installer=readFileSync('deploy/lab/open-webui/install_treeai_action.py','utf8');
		expect(installer).toContain('/api/v1/auths/signin');
		expect(installer).toContain('"authorization": f"Bearer {token}"');
		expect(installer).toContain('call("GET", "/")');
		expect(installer).not.toContain('print(token)');
		expect(readFileSync('packages/lab/src/library-bridge.ts','utf8')).toContain('exactly one attached Knowledge Base');
		expect(action).not.toMatch(/api[_-]?key\s*=/iu);
		const platform = readFileSync(
			"packages/manager/src/lifecycle/platform.ts",
			"utf8",
		);
		expect(platform).toContain('"127.0.0.1:443:443"');
		expect(platform).toContain('"127.0.0.1" : "0.0.0.0"');
		expect(platform).toContain("ports.override.yml");
	});

	it("provides environment-controlled single-user security settings", () => {
		const compose = YAML.parse(readFileSync("deploy/lab/compose.yml", "utf8"));
		const environment = compose.services["open-webui"].environment;
		expect(environment.ENABLE_PERSISTENT_CONFIG).toBe("false");
		expect(environment.ENABLE_OPENAI_API).toBe("true");
		expect(environment.ENABLE_OLLAMA_API).toBe("false");
		expect(environment.WEBUI_SESSION_COOKIE_SECURE).toBe("true");
		expect(environment.WEBUI_AUTH).toBe("${OPEN_WEBUI_AUTH:-true}");
	});

	it("reads authentication state from the Open WebUI API response shape", () => {
		expect(() =>
			assertWebUiAuthenticationDisabled({ features: { auth: false } }),
		).not.toThrow();
		for (const response of [
			{ features: { auth: true } },
			{ auth: false },
			{},
			null,
		])
			expect(() => assertWebUiAuthenticationDisabled(response)).toThrow(
				/authentication enabled/u,
			);
	});

	it("stages configuration and backs up only the Open WebUI volume", () => {
		const lifecycle = readFileSync(
			"packages/manager/src/lifecycle/lab-webui.ts",
			"utf8",
		);
		expect(lifecycle).toContain("open-webui-pending.json");
		expect(lifecycle).toContain("treeseed-ai-lab_open-webui-data");
		expect(lifecycle).toContain("reset-webui requires --confirm");
		expect(lifecycle).toContain("reset-rolled-back");
		expect(lifecycle).not.toContain("hermes-home");
		const platform = readFileSync(
			"packages/manager/src/lifecycle/platform.ts",
			"utf8",
		);
		expect(platform).toContain('command("chown", ["root:treeseed-ai-lab"');
		expect(platform).toContain('RUNTIME_GID: productGroup("lab")');
	});

	it("attributes proxy traffic by its non-secret provider identity", () => {
		const proxy = readFileSync("packages/lab/src/proxy.ts", "utf8");
		expect(proxy).toContain("Bearer lab-open-webui");
		expect(proxy).toContain('return "open-webui"');
		expect(proxy).toContain('headers.set("authorization"');
	});

	it("keeps browser launch fixed and certificate replacement transactional", () => {
		const cli = readFileSync("packages/lab/src/cli.ts", "utf8");
		const converge = readFileSync("packages/manager/src/bin/converge.ts", "utf8");
		const tls = readFileSync(
			"packages/manager/src/lifecycle/certificates/tls.ts",
			"utf8",
		);
		expect(cli).toContain('["webui", "hermes"].includes');
		expect(cli).toContain('spawn("/usr/bin/xdg-open", [target]');
		expect(tls).toContain('"-checkhost"');
		expect(converge).toContain("certificate.rollback()");
		const platform = readFileSync(
			"packages/manager/src/lifecycle/platform.ts",
			"utf8",
		);
		expect(platform).toContain("ensurePlatformTls(configuration)");
		expect(platform).toContain("certificate.rollback()");
	});
});
