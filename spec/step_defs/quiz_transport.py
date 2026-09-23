"""Socket test client shared by fixtures and isolated-server scenarios."""
from __future__ import annotations
import time
from collections.abc import Callable
from typing import Any
import socketio


class SocketClient:
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.sio = socketio.Client(
            reconnection=False,
            logger=False,
            engineio_logger=False,
        )
        self.events: list[dict[str, Any]] = []
        self.last_ack: dict[str, Any] | None = None
        # 待機の実装。frontend test では Playwright に制御を返す関数に差し替える (frontend/conftest.py)。
        # sync API の route handler (MusicKit API mock) は test 側が Playwright を呼んでいる間しか動かないため、
        # time.sleep で待つと mock 応答が待機終了まで止まる。
        self.sleep: Callable[[float], None] = time.sleep
        self.sio.on("state", self._on_state)
        self.sio.connect(server_url, transports=["websocket"], socketio_path="socket.io", wait_timeout=5)

    def _on_state(self, payload: dict[str, Any]) -> None:
        self.events.append(payload)

    def close(self) -> None:
        if self.sio.connected:
            self.sio.disconnect()

    def emit(self, event: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if payload is None and event.endswith("-ended"):
            payload = {"operationId": self.state["operationId"]}
        event_count = len(self.events)
        response = self.sio.call(event, data=payload, timeout=5)
        assert isinstance(response, dict), response
        assert isinstance(response.get("ok"), bool), response
        self.last_ack = response
        if response["ok"]:
            return self.wait_for_next_state(event_count)
        return self.state

    def send(self, event: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if payload is None and event.endswith("-ended"):
            payload = {"operationId": self.state["operationId"]}
        self.sio.emit(event, data=payload)
        self.sleep(0.02)
        return self.state

    def wait_for_next_state(self, event_count: int) -> dict[str, Any]:
        deadline = time.time() + 5
        while time.time() < deadline:
            if len(self.events) > event_count:
                return self.events[-1]
            self.sleep(0.02)
        raise AssertionError(f"state event after {event_count} not observed; latest={self.events[-1] if self.events else None}")

    def wait_for_state(self, **expected: Any) -> dict[str, Any]:
        deadline = time.time() + 5
        while time.time() < deadline:
            if self.events:
                state = self.events[-1]
                if all(state.get(key) == value for key, value in expected.items()):
                    return state
            self.sleep(0.02)
        raise AssertionError(f"state with {expected} not observed; latest={self.events[-1] if self.events else None}")

    @property
    def state(self) -> dict[str, Any]:
        assert self.events, "no state event received"
        return self.events[-1]

