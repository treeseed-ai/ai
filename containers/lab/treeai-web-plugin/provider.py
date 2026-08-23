import os
from typing import Any, Dict, List

import httpx
from agent.web_search_provider import WebSearchProvider


class TreeAIWebProvider(WebSearchProvider):
	@property
	def name(self) -> str:
		return "treeai"

	@property
	def display_name(self) -> str:
		return "TreeAI Safe Web"

	def is_available(self) -> bool:
		return bool(os.getenv("TREEAI_WEB_TOOL_URL"))

	def supports_search(self) -> bool:
		return True

	def supports_extract(self) -> bool:
		return True

	def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
		response = httpx.post(f"{os.environ['TREEAI_WEB_TOOL_URL']}/search", json={"query": query, "limit": limit}, timeout=35)
		response.raise_for_status()
		results = response.json()["results"]
		for position, result in enumerate(results, 1):
			result.setdefault("description", "")
			result["position"] = position
		return {"success": True, "data": {"web": results}}

	def extract(self, urls: List[str], **kwargs: Any) -> List[Dict[str, Any]]:
		response = httpx.post(f"{os.environ['TREEAI_WEB_TOOL_URL']}/extract", json={"urls": urls}, timeout=90)
		response.raise_for_status()
		return [
			{
				"url": item["finalUrl"],
				"title": item["finalUrl"],
				"content": item["text"],
				"raw_content": item["text"],
				"metadata": {key: value for key, value in item.items() if key != "text"},
			}
			for item in response.json()["results"]
		]
