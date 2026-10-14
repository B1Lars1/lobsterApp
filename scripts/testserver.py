"""Enkel testserver for appen på http://localhost:8000.

I motsetning til «python -m http.server» ber den nettleseren om ikke å mellomlagre
filene, så endringer i koden vises med en gang du laster siden på nytt.

Kjør fra roten av repoet:  python scripts/testserver.py [port]
"""

import functools
import http.server
import sys

from config import ROOT


class UtenMellomlagring(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".geojson": "application/geo+json",
        ".js": "text/javascript",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(UtenMellomlagring, directory=str(ROOT / "app"))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Appen kjører på http://localhost:{port}  (Ctrl+C for å stoppe)")
        server.serve_forever()


if __name__ == "__main__":
    main()
