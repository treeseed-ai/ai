#!/usr/bin/env python3
import json
import os
import urllib.request


model = os.environ.get("TREESEED_VLLM_MODEL", "local-model")
request = urllib.request.Request(
    "http://127.0.0.1:8000/v1/chat/completions",
    data=json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": "Reply with OK."}],
            "max_tokens": 2,
            "temperature": 0,
        }
    ).encode(),
    headers={"content-type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(request, timeout=120) as response:
    value = json.loads(response.read())
if not value.get("choices"):
    raise RuntimeError("vLLM warm-up returned no completion")
