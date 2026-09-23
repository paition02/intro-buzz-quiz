"""Shared pytest-bdd fixtures for intro-buzz-quiz regression specs."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest
from dotenv import load_dotenv

from quiz_transport import SocketClient

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env", override=False)


@pytest.fixture(scope="session")
def server_url() -> Iterator[str]:
    configured = os.environ.get("TEST_BACKEND_URL", "").strip().rstrip("/")
    if not configured:
        pytest.exit("TEST_BACKEND_URL is required. Set it in the environment or in .env.", returncode=2)

    yield configured

@pytest.fixture
def http(server_url: str):
    with httpx.Client(base_url=server_url, timeout=5) as client:
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
