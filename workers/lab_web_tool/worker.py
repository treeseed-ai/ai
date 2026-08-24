#!/usr/bin/env python3
"""Private, credential-free web search and extraction worker for Hermes."""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import socket
import ssl
import zlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote_plus, unquote, urlencode, urljoin, urlsplit

MAX_BODY = 5 * 1024 * 1024
MAX_COMPRESSED_BODY = 2 * 1024 * 1024
MAX_REQUEST = 16 * 1024
MAX_REDIRECTS = 3
TIMEOUT = 15
TEXT_TYPES = ("text/", "application/xhtml+xml")


class PinnedHTTPSConnection(http.client.HTTPSConnection):
	def __init__(self, address: str, hostname: str, port: int) -> None:
		super().__init__(address, port, timeout=TIMEOUT, context=ssl.create_default_context())
		self._treeai_hostname = hostname

	def connect(self) -> None:
		raw = socket.create_connection((self.host, self.port), self.timeout)
		self.sock = self._context.wrap_socket(raw, server_hostname=self._treeai_hostname)


class TextExtractor(HTMLParser):
	def __init__(self) -> None:
		super().__init__(convert_charrefs=True)
		self.parts: list[str] = []
		self.hidden = 0

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		if tag in {"script", "style", "noscript", "svg"}:
			self.hidden += 1
		elif tag in {"p", "br", "div", "li", "h1", "h2", "h3", "h4"}:
			self.parts.append("\n")

	def handle_endtag(self, tag: str) -> None:
		if tag in {"script", "style", "noscript", "svg"} and self.hidden:
			self.hidden -= 1

	def handle_data(self, data: str) -> None:
		if not self.hidden:
			self.parts.append(data)

	def text(self) -> str:
		return "\n".join(line.strip() for line in "".join(self.parts).splitlines() if line.strip())


class SearchExtractor(HTMLParser):
	def __init__(self) -> None:
		super().__init__(convert_charrefs=True)
		self.results: list[dict[str, str]] = []
		self.current: dict[str, str] | None = None

	def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
		values = dict(attrs)
		if tag == "a" and "result__a" in values.get("class", ""):
			href = values.get("href", "")
			query = parse_qs(urlsplit(href).query)
			self.current = {"url": unquote(query.get("uddg", [href])[0]), "title": ""}

	def handle_data(self, data: str) -> None:
		if self.current is not None:
			self.current["title"] += data

	def handle_endtag(self, tag: str) -> None:
		if tag == "a" and self.current is not None:
			self.current["title"] = self.current["title"].strip()
			if self.current["url"] and self.current["title"]:
				self.results.append(self.current)
			self.current = None


def public_addresses(host: str) -> list[str]:
	addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)})
	if not addresses:
		raise ValueError("hostname did not resolve")
	for value in addresses:
		address = ipaddress.ip_address(value)
		if not address.is_global or any(
			(address.is_private, address.is_loopback, address.is_link_local,
			 address.is_multicast, address.is_reserved, address.is_unspecified)
		):
			raise ValueError("target resolves to a forbidden address")
	return addresses


def fetch(url: str, redirects: int = 0, body: bytes | None = None) -> tuple[str, bytes, str, int]:
	if redirects > MAX_REDIRECTS:
		raise ValueError("redirect limit exceeded")
	parsed = urlsplit(url)
	if parsed.scheme not in {"http", "https"} or not parsed.hostname:
		raise ValueError("only HTTP and HTTPS URLs are supported")
	if parsed.username or parsed.password or parsed.port not in {None, 80, 443}:
		raise ValueError("URL credentials and nonstandard ports are forbidden")
	address = public_addresses(parsed.hostname)[0]
	port = parsed.port or (443 if parsed.scheme == "https" else 80)
	if parsed.scheme == "https":
		connection = PinnedHTTPSConnection(address, parsed.hostname, port)
	else:
		connection = http.client.HTTPConnection(address, port, timeout=TIMEOUT)
	path = parsed.path or "/"
	if parsed.query:
		path += f"?{parsed.query}"
	headers = {"Host": parsed.netloc, "User-Agent": "TreeAI-WebTool/0.9.0", "Accept": "text/html,text/plain,application/xhtml+xml"}
	if body is not None:
		headers.update({"Content-Type": "application/x-www-form-urlencoded", "Content-Length": str(len(body))})
	connection.request("POST" if body is not None else "GET", path, body=body, headers=headers)
	response = connection.getresponse()
	if response.status in {301, 302, 303, 307, 308}:
		location = response.getheader("Location")
		connection.close()
		if not location:
			raise ValueError("redirect is missing Location")
		return fetch(urljoin(url, location), redirects + 1, body if response.status in {307, 308} else None)
	content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].lower()
	if not any(content_type.startswith(prefix) for prefix in TEXT_TYPES):
		connection.close()
		raise ValueError(f"unsupported content type: {content_type or 'unknown'}")
	encoding = (response.getheader("Content-Encoding") or "identity").lower()
	if encoding not in {"identity", "gzip", "deflate"}:
		connection.close()
		raise ValueError("unsupported content encoding")
	read_limit = MAX_COMPRESSED_BODY if encoding != "identity" else MAX_BODY
	declared = response.getheader("Content-Length")
	if declared and int(declared) > read_limit:
		connection.close()
		raise ValueError("response exceeds size limit")
	body = response.read(read_limit + 1)
	connection.close()
	if len(body) > read_limit:
		raise ValueError("response exceeds size limit")
	if encoding != "identity":
		decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS)
		body = decompressor.decompress(body, MAX_BODY + 1)
		if len(body) > MAX_BODY or decompressor.unconsumed_tail:
			raise ValueError("decompressed response exceeds size limit")
		body += decompressor.flush(MAX_BODY + 1 - len(body))
		if len(body) > MAX_BODY:
			raise ValueError("decompressed response exceeds size limit")
	return url, body, content_type, response.status


def extract(url: str) -> dict[str, object]:
	final_url, body, content_type, status = fetch(url)
	text = body.decode("utf-8", errors="replace")
	if "html" in content_type:
		parser = TextExtractor()
		parser.feed(text)
		text = parser.text()
	return {"url": url, "finalUrl": final_url, "retrievedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
		"mimeType": content_type, "status": status, "sha256": hashlib.sha256(body).hexdigest(), "text": text}


def search(query: str, limit: int) -> list[dict[str, object]]:
	endpoint = "https://html.duckduckgo.com/html/"
	requested_url = f"{endpoint}?q={quote_plus(query)}"
	final_url, body, content_type, status = fetch(endpoint, body=urlencode({"q": query}).encode())
	if status != 200:
		raise ValueError(f"search provider returned HTTP {status}")
	parser = SearchExtractor()
	parser.feed(body.decode("utf-8", errors="replace"))
	results = []
	retrieved_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
	provenance = {"requestedUrl": requested_url, "finalUrl": final_url, "retrievedAt": retrieved_at,
		"mimeType": content_type, "status": status, "sha256": hashlib.sha256(body).hexdigest()}
	for item in parser.results:
		try:
			parsed = urlsplit(item["url"])
			if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.port not in {None, 80, 443}:
				continue
			public_addresses(parsed.hostname)
		except (ValueError, OSError):
			continue
		results.append({**item, "provenance": provenance})
		if len(results) >= max(1, min(limit, 10)):
			break
	return results


class Handler(BaseHTTPRequestHandler):
	def reply(self, status: int, value: object) -> None:
		body = json.dumps(value, separators=(",", ":")).encode()
		self.send_response(status)
		self.send_header("content-type", "application/json")
		self.send_header("content-length", str(len(body)))
		self.end_headers()
		self.wfile.write(body)

	def do_GET(self) -> None:  # noqa: N802
		if self.path == "/healthz":
			return self.reply(200, {"ok": True})
		return self.reply(404, {"error": {"code": "not_found", "message": "Route not found"}})

	def do_POST(self) -> None:  # noqa: N802
		try:
			length = int(self.headers.get("content-length", "0"))
			if length < 1 or length > MAX_REQUEST:
				raise ValueError("invalid request size")
			value = json.loads(self.rfile.read(length))
			if self.path == "/search":
				query = str(value.get("query", "")).strip()
				if not query or len(query) > 500:
					raise ValueError("query is required and must be at most 500 characters")
				return self.reply(200, {"results": search(query, int(value.get("limit", 5)))})
			if self.path == "/extract":
				urls = value.get("urls", [])
				if not isinstance(urls, list) or not 1 <= len(urls) <= 5:
					raise ValueError("one to five URLs are required")
				return self.reply(200, {"results": [extract(str(url)) for url in urls]})
			return self.reply(404, {"error": {"code": "not_found", "message": "Route not found"}})
		except (ValueError, OSError, json.JSONDecodeError) as error:
			return self.reply(400, {"error": {"code": "web_request_rejected", "message": str(error)}})

	def log_message(self, format: str, *args: object) -> None:
		return


if __name__ == "__main__":
	ThreadingHTTPServer(("0.0.0.0", 8090), Handler).serve_forever()
