"""
title: Train Library
description: Freeze and train the one Open WebUI Knowledge Base attached to this chat.
author: TreeSeed AI
version: 0.9.0
required_open_webui_version: 0.11.0
"""

import asyncio
import json
import urllib.error
import urllib.request
import uuid


BRIDGE = "http://library-bridge:8082"


def _request(method, path, authorization, body=None):
    payload = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{BRIDGE}{path}",
        data=payload,
        method=method,
        headers={
            "authorization": authorization,
            "content-type": "application/json",
            "idempotency-key": f"open-webui:{uuid.uuid4()}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        value = json.loads(error.read() or b"{}")
        raise RuntimeError(value.get("error", {}).get("message", str(error))) from error


class Action:
    async def action(
        self,
        body: dict,
        __request__=None,
        __event_emitter__=None,
        __event_call__=None,
    ):
        if not body.get("chat_id") or __request__ is None:
            raise RuntimeError("Train Library requires a saved chat.")
        authorization = __request__.headers.get("authorization", "")
        if not authorization:
            raise RuntimeError("The current Open WebUI session is unavailable.")
        preview = await asyncio.to_thread(
            _request,
            "GET",
            f"/treeai/v1/chats/{body['chat_id']}/library",
            authorization,
        )
        mode = await __event_call__(
            {
                "type": "input",
                "data": {
                    "title": "Train Library",
                    "message": "Enter smoke or standard.",
                    "placeholder": "smoke",
                    "value": "smoke",
                },
            }
        )
        mode = str(mode or "").strip().lower()
        if mode not in {"smoke", "standard"}:
            await __event_emitter__(
                {"type": "notification", "data": {"type": "warning", "content": "Training cancelled: choose smoke or standard."}}
            )
            return None
        counts = preview["counts"]
        confirmed = await __event_call__(
            {
                "type": "confirmation",
                "data": {
                    "title": f"Train {preview['name']}",
                    "message": (
                        f"Freeze a {mode} revision with {counts['ready']} ready, "
                        f"{counts['pending']} pending, {counts['rejected']} rejected files "
                        f"and about {preview['estimatedTokens']} tokens?"
                    ),
                },
            }
        )
        if not confirmed:
            return None
        await __event_emitter__({"type": "status", "data": {"description": "Synchronizing and freezing the library...", "done": False}})
        result = await asyncio.to_thread(
            _request,
            "POST",
            f"/treeai/v1/chats/{body['chat_id']}/train",
            authorization,
            {"mode": mode},
        )
        await __event_emitter__({"type": "status", "data": {"description": f"Library cycle {result['cycle']['id']} submitted.", "done": True}})
        await __event_emitter__({"type": "notification", "data": {"type": "success", "content": "Library training cycle submitted."}})
        return None
