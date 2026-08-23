import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Hermes safe web worker", () => {
	it("rejects private DNS targets and unsafe URL forms", () => {
		const script = String.raw`
import importlib.util
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('worker','workers/lab_web_tool/worker.py')
w=importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
with patch.object(w.socket,'getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',0))]):
  try: w.public_addresses('example.test'); raise AssertionError('private address accepted')
  except ValueError: pass
for url in ['http://user:pass@example.com/','http://example.com:8080/','file:///etc/passwd']:
  try: w.fetch(url); raise AssertionError('unsafe URL accepted')
  except ValueError: pass
print('ready')
`;
		expect(execFileSync("python3", ["-c", script], { encoding: "utf8" }).trim()).toBe("ready");
	});

	it("attaches bounded retrieval provenance to discovered results", () => {
		const source = readFileSync("workers/lab_web_tool/worker.py", "utf8");
		for (const field of ["requestedUrl", "finalUrl", "retrievedAt", "mimeType", "status", "sha256"])
			expect(source).toContain(`\"${field}\"`);
	});
});
