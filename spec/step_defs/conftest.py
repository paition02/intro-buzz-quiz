"""Shared pytest-bdd fixtures for intro-buzz-quiz regression specs."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
import socketio
from dotenv import load_dotenv
from tls_helpers import tls_verify, websocket_ssl_options

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env", override=False)


@pytest.fixture(scope="session")
def server_url() -> Iterator[str]:
    configured = os.environ.get("TEST_BACKEND_URL", "").strip().rstrip("/")
    if not configured:
        pytest.exit("TEST_BACKEND_URL is required. Set it in the environment or in .env.", returncode=2)

    yield configured


class SocketClient:
    def __init__(self, server_url: str):
        self.server_url = server_url
        self.sio = socketio.Client(
            reconnection=False,
            logger=False,
            engineio_logger=False,
            websocket_extra_options=websocket_ssl_options(server_url),
        )
        self.events: list[dict[str, Any]] = []
        self.sio.on("state", self._on_state)
        self.sio.connect(server_url, transports=["websocket"], socketio_path="socket.io", wait_timeout=5)

    def _on_state(self, payload: dict[str, Any]) -> None:
        self.events.append(payload)

    def close(self) -> None:
        if self.sio.connected:
            self.sio.disconnect()

    def emit(self, event: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self.sio.call(event, data=payload, timeout=5)
        assert isinstance(response, dict), response
        assert response.get("ok") is True, response
        state = response.get("state")
        assert isinstance(state, dict), response
        return state

    def wait_for_state(self, **expected: Any) -> dict[str, Any]:
        deadline = time.time() + 5
        while time.time() < deadline:
            if self.events:
                state = self.events[-1]
                if all(state.get(key) == value for key, value in expected.items()):
                    return state
            time.sleep(0.02)
        raise AssertionError(f"state with {expected} not observed; latest={self.events[-1] if self.events else None}")

    @property
    def state(self) -> dict[str, Any]:
        assert self.events, "no state event received"
        return self.events[-1]


@pytest.fixture
def http(server_url: str):
    with httpx.Client(base_url=server_url, timeout=5, verify=tls_verify(server_url)) as client:
        yield client


@pytest.fixture
def socket_client(server_url: str):
    client = SocketClient(server_url)
    client.wait_for_state()
    client.emit("console:reset")
    client.wait_for_state(phase="initialization", step="idle")
    try:
        yield client
    finally:
        client.close()


@dataclass
class ScenarioContext:
    state: dict[str, Any] | None = None
    response: httpx.Response | None = None
    actor_id: str | None = None
    tracks: list[dict[str, Any]] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@pytest.fixture
def ctx() -> ScenarioContext:
    return ScenarioContext()
