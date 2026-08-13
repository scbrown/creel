#!/usr/bin/env python3
"""creel — local DeepSeek CORS proxy for development.

Same shape as deepseek-cors-worker.js, run locally: forwards requests to
https://api.deepseek.com and adds CORS headers so the harness page can call
it. BYOK passthrough — the browser sends its own Authorization header; this
process holds no secrets.

Usage: python3 proxy/local-proxy.py [port]   (default 8421)
Then set http://localhost:8421 as the API Endpoint in creel's settings.
"""

import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.deepseek.com"
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
}


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command)
        for header in ("Authorization", "Content-Type", "Accept"):
            if self.headers.get(header):
                req.add_header(header, self.headers[header])
        try:
            resp = urllib.request.urlopen(req)
            status, payload, ctype = resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, payload, ctype = e.code, e.read(), e.headers.get("Content-Type", "application/json")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _forward
    do_POST = _forward

    def log_message(self, fmt, *args):
        sys.stderr.write("proxy: %s\n" % (fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8421
    print(f"DeepSeek CORS proxy on http://localhost:{port} -> {UPSTREAM}")
    ThreadingHTTPServer(("127.0.0.1", port), Proxy).serve_forever()
