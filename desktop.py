"""Native desktop launcher for the Cape Coral Code Watch dashboard."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from threading import Thread

import webview


def public_directory() -> Path:
    if hasattr(sys, "_MEIPASS"):
        directory = Path(sys._MEIPASS) / "public"
    else:
        directory = Path(__file__).parent / ".github" / "extensions" / "case-search" / "public"

    if not directory.is_dir():
        raise RuntimeError(f"Dashboard assets are missing: {directory}")
    return directory


def start_server(directory: Path) -> ThreadingHTTPServer:
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    server = start_server(public_directory())
    port = server.server_address[1]
    try:
        webview.create_window(
            "Cape Coral Code Watch",
            f"http://127.0.0.1:{port}/Case%20Search%20v2.dc.html",
            min_size=(1024, 720),
        )
        webview.start()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
