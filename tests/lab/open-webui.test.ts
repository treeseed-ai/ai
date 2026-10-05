import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
describe("Open WebUI local single-user integration", () => {

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
		expect(compose.services.gateway).toBeUndefined();
		expect(compose.services['library-bridge'].networks).toEqual(['lab-private','platform']);
		expect(compose.services['library-bridge'].secrets).toEqual(['training-ingest-key','lab-library-action-key']);
		expect(compose.services['library-bridge'].group_add).toEqual([
			"${RUNTIME_GID:?RUNTIME_GID is required}",
		]);
		expect(compose.services['open-webui'].volumes).toEqual(['open-webui-data:/app/backend/data']);
		expect(compose.services['open-webui-action-init'].image).toBe('${LAB_OPEN_WEBUI_IMAGE:?LAB_OPEN_WEBUI_IMAGE is required}');
		expect(compose.services['open-webui-action-init'].entrypoint).toEqual(['python','/opt/treeai/actions/install_treeai_action.py']);
		const action=readFileSync('deploy/lab/open-webui/treeai_train_library.py','utf8');
		expect(action).toContain('class Action:');
		const installer=readFileSync('deploy/lab/open-webui/install_treeai_action.py','utf8');
		expect(installer).toContain('/api/v1/auths/signin');
		expect(installer).toContain('OPEN_WEBUI_ORIGIN');
		expect(installer).toContain('"authorization": f"Bearer {token}"');
		expect(installer).toContain('call("GET", "/")');
		expect(installer).not.toContain('print(token)');
		expect(readFileSync('packages/lab/src/library-bridge.ts','utf8')).toContain('exactly one attached Knowledge Base');
		expect(action).not.toMatch(/api[_-]?key\s*=/iu);

	});

	it("provides environment-controlled single-user security settings", () => {
		const compose = YAML.parse(readFileSync("deploy/lab/compose.yml", "utf8"));
		const environment = compose.services["open-webui"].environment;
		expect(environment.ENABLE_PERSISTENT_CONFIG).toBe("false");
		expect(environment.ENABLE_OPENAI_API).toBe("true");
		expect(environment.ENABLE_OLLAMA_API).toBe("false");
		expect(environment.WEBUI_SESSION_COOKIE_SECURE).toBe("true");
		expect(environment.WEBUI_AUTH).toBe("${OPEN_WEBUI_AUTH:-false}");
		expect(environment.ENABLE_LOGIN_FORM).toBe("${OPEN_WEBUI_ENABLE_LOGIN_FORM:-false}");
		expect(environment.BYPASS_MODEL_ACCESS_CONTROL).toBe("${OPEN_WEBUI_BYPASS_MODEL_ACCESS_CONTROL:-true}");
		expect(environment.WEBUI_URL).toBe("${OPEN_WEBUI_URL:-https://chat.ai.treeseed.localhost}");
	});



	it("attributes proxy traffic by its non-secret provider identity", () => {
		const proxy = readFileSync("packages/lab/src/proxy.ts", "utf8");
		expect(proxy).toContain("Bearer lab-open-webui");
		expect(proxy).toContain('return "open-webui"');
		expect(proxy).toContain('headers.set("authorization"');
	});

});
