"""Standalone launcher for the Map Capture desktop executable."""

from __future__ import annotations

import socket
import sys
import threading
import webbrowser
from pathlib import Path


def bundled_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return Path(__file__).resolve().parents[2]


ROOT_DIR = bundled_root()
for relative in ("apps/kosis", "apps/report_data", "apps/overtime_journal"):
    path = ROOT_DIR / relative
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

import web_server  # noqa: E402


def choose_port(preferred: int = 8765) -> int:
    for port in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError("사용 가능한 로컬 포트를 찾지 못했습니다.")


def main() -> int:
    host = "127.0.0.1"
    port = choose_port()
    should_open = "--no-open" not in sys.argv[1:]
    url = f"http://{host}:{port}/portal/pages/map_capture.html?v={web_server.ASSET_VERSION}"
    try:
        server = web_server.LocalDeskServer((host, port), web_server.LocalDeskHandler)
    except OSError as error:
        print(f"지도 캡처 서버를 시작하지 못했습니다: {error}")
        return 1

    print("지도 캡처 실행 중")
    print(f"URL: {url}")
    print("종료하려면 이 창에서 Ctrl+C를 누르거나 창을 닫으세요.")
    if should_open:
        threading.Timer(0.6, lambda: webbrowser.open(url, new=1, autoraise=True)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n지도 캡처를 종료합니다.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
