import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def serve(routes, port=8080):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/healthz": self.respond(200, {"ok": True})
            else: self.respond(404, {"error": "not_found"})
        def do_POST(self):
            try:
                size = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(size) or b"{}")
                route = routes.get(self.path)
                if not route: return self.respond(404, {"error": "not_found"})
                self.respond(200, route(request))
            except ValueError as error: self.respond(400, {"error": str(error)})
            except Exception as error: self.respond(500, {"error": str(error)})
        def respond(self, status, body):
            value = json.dumps(body).encode()
            self.send_response(status); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(value))); self.end_headers(); self.wfile.write(value)
        def log_message(self, pattern, *args): print(json.dumps({"message": pattern % args}))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
