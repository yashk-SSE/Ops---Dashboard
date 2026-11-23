"""Local dev server for the dashboard: serves web/ with no-cache headers so every reload shows the latest files.

Usage:  python -m pipeline.tools.serve [--port 8765]
(For production the static host serves web/; see docs/dashboard/README.md.)
"""
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from pipeline.config import REPO_ROOT


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Serve web/ locally without caching")
    ap.add_argument("--port", type=int, default=8765)
    port = ap.parse_args().port
    handler = functools.partial(NoCacheHandler, directory=str(REPO_ROOT / "web"))
    print(f"Dashboard on http://127.0.0.1:{port}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
