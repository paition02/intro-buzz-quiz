from __future__ import annotations

from typing import Iterator

import pytest
from playwright.sync_api import Browser, Page, Playwright, sync_playwright

from frontend.helpers import musickit_mock_script


@pytest.fixture(scope="session")
def playwright_instance() -> Iterator[Playwright]:
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="session")
def browser(playwright_instance: Playwright) -> Iterator[Browser]:
    browser = playwright_instance.chromium.launch(
        executable_path="/usr/bin/chromium-browser",
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage"],
    )
    try:
        yield browser
    finally:
        browser.close()


@pytest.fixture
def frontend_page(browser: Browser, server_url: str, socket_client) -> Iterator[Page]:
    context = browser.new_context(base_url=server_url)
    page = context.new_page()
    page.route(
        "**/musickit/v3/musickit.js",
        lambda route: route.fulfill(status=200, content_type="application/javascript", body=musickit_mock_script()),
    )
    page.route(
        "**/api/token",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body='{"token":"spec-token","expiresAt":"2099-01-01T00:00:00.000Z"}',
        ),
    )
    page.add_init_script(
        """
        window.AudioContext = window.AudioContext || class {
          constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
          createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
          createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {}, type: 'sine' }; }
          resume() { return Promise.resolve(); }
          close() { return Promise.resolve(); }
        };
        """
    )
    try:
        yield page
    finally:
        context.close()
