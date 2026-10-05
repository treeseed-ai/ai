import json
import os
import urllib.error
import urllib.request
from pathlib import Path


origin = os.environ.get("OPEN_WEBUI_ORIGIN", "http://127.0.0.1:8080").rstrip("/")
base = f"{origin}/api/v1/functions"
identifier = "treeai_train_library"
payload = {
    "id": identifier,
    "name": "Train Library",
    "content": Path("/opt/treeai/actions/treeai_train_library.py").read_text(),
    "meta": {"description": "Freeze and train the Knowledge Base attached to this chat."},
}


def system_session():
    request = urllib.request.Request(
        f"{origin}/api/v1/auths/signin",
        data=json.dumps({"email": "admin@localhost", "password": "admin"}).encode(),
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            token = json.loads(response.read()).get("token")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Open WebUI system session failed: {error.read().decode()}") from error
    if not isinstance(token, str) or not token:
        raise RuntimeError("Open WebUI system session returned no token")
    return token


token = system_session()


def call(method, path, body=None):
    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(error.read().decode()) from error


current = next(
    (item for item in call("GET", "/") if item.get("id") == identifier),
    None,
)
current = call("POST", f"/id/{identifier}/update" if current else "/create", payload)
if not current.get("is_active"):
    current = call("POST", f"/id/{identifier}/toggle")
if not current.get("is_global"):
    current = call("POST", f"/id/{identifier}/toggle/global")
if not current.get("is_active") or not current.get("is_global"):
    raise RuntimeError("TreeAI Train Library action is not active and global")
print(json.dumps({"id": identifier, "installed": True}))
