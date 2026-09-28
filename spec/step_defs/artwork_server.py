"""サーバーがジャケット画像を取得できる、テスト用のローカル画像サーバー。"""
from __future__ import annotations

import struct
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _png(pixel) -> bytes:
    size = 64
    rows = b"".join(b"\x00" + bytes(channel for x in range(size) for channel in pixel(x, y)) for y in range(size))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


IMAGES = {
    "gradient": _png(lambda x, y: (x * 4, y * 4, (x + y) * 2)),
    "checker": _png(lambda x, y: (255, 255, 255) if (x // 8 + y // 8) % 2 else (0, 0, 0)),
}


class ArtworkServer:
    def __init__(self) -> None:
        self.held = threading.Event()
        self.held.set()
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                name = self.path.strip("/").split("/")[-1].split(".")[0].split("-")[0]
                if self.path.startswith("/held/"):
                    server.held.wait(10)
                body = IMAGES.get(name)
                if body is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/{path}"

    def close(self) -> None:
        self.held.set()
        self.httpd.shutdown()
