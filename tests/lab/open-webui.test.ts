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
		expect(compose.services.gateway.ports[0]).toBe(
			"${OPEN_WEBUI_PUBLISH:-0.0.0.0:4791:4791}",
		);
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
	});

	it("attributes proxy traffic by its non-secret provider identity", () => {
		const proxy = readFileSync("packages/lab/src/proxy.ts", "utf8");
		expect(proxy).toContain("Bearer lab-open-webui");
		expect(proxy).toContain("return'open-webui'");
		expect(proxy).toContain("headers.set('authorization'");
	});

	it("keeps browser launch fixed and certificate replacement transactional", () => {
		const cli = readFileSync("packages/lab/src/cli.ts", "utf8");
		const converge = readFileSync("packages/manager/src/bin/converge.ts", "utf8");
		expect(cli).toContain('targets.length !== 1 || targets[0] !== "webui"');
		expect(cli).toContain('spawn("/usr/bin/xdg-open", [webui.browserUrl]');
		expect(converge).toContain('"-checkhost"');
		expect(converge).toContain("certificate.rollback()");
	});
});
