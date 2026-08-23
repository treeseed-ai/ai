from .provider import TreeAIWebProvider


def correlate_llm_request(request, session_id="", turn_id="", **_context):
	"""Attach non-secret correlation IDs to Hermes' inner model request."""
	updated = dict(request)
	headers = dict(updated.get("extra_headers") or {})
	if session_id:
		headers["x-treeai-hermes-session-id"] = str(session_id)
	if turn_id:
		headers["x-treeai-hermes-turn-id"] = str(turn_id)
	updated["extra_headers"] = headers
	return {"request": updated, "reason": "treeai-session-correlation"}


def register(ctx):
	ctx.register_web_search_provider(TreeAIWebProvider())
	ctx.register_middleware("llm_request", correlate_llm_request)
