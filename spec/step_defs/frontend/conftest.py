"""Frontend fixtures.

Frontend tests are E2E: a real browser drives the SPA served by a real
server. Tests observe the console, gameboard, and action pages and drive the
game through them and the action API. The server's state is never read over
the socket.
"""

from __future__ import annotations

import os
import shutil
from typing import Iterator

import pytest
from playwright.sync_api import Browser, BrowserContext, Error as PlaywrightError, Page, Playwright, sync_playwright

from playwright.sync_api import expect

from frontend.helpers import STAGE_TIMEOUT_MS, console_stage, expect_no_participants, expect_no_selection, expect_stage
from frontend.musickit_mock import configure_musickit_api_mock, make_developer_token


@pytest.fixture(scope="session")
def playwright_instance() -> Iterator[Playwright]:
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="session")
def browser(playwright_instance: Playwright) -> Iterator[Browser]:
    launch_options = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-dev-shm-usage"],
    }
    executable_path = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or shutil.which("chromium-browser") or shutil.which("chromium")
    if executable_path:
        launch_options["executable_path"] = executable_path

    try:
        browser = playwright_instance.chromium.launch(**launch_options)
    except PlaywrightError:
        if executable_path:
            raise
        browser = playwright_instance.chromium.launch(
            **launch_options,
            channel=os.environ.get("PLAYWRIGHT_BROWSER_CHANNEL", "chrome"),
        )
    try:
        yield browser
    finally:
        browser.close()


def json_token_response() -> str:
    return f'{{"token":"{make_developer_token()}","expiresAt":"2099-01-01T00:00:00.000Z"}}'


def prepare_page(page: Page) -> None:
    configure_musickit_api_mock(page)
    page.route(
        "**/api/token",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json_token_response(),
        ),
    )


def reset_game(context: BrowserContext) -> None:
    """Return the shared game to its initial state the way a host does: from the console."""
    page = context.new_page()
    try:
        prepare_page(page)
        page.goto("/console")
        # A fresh console renders its default view until the server's state arrives;
        # only a connected console shows the shared game that the reset acts on.
        expect(console_stage(page)).to_be_visible(timeout=STAGE_TIMEOUT_MS)
        expect(page.get_by_role("status")).to_have_count(0, timeout=STAGE_TIMEOUT_MS)
        page.get_by_role("button", name="リセット", exact=True).click(timeout=10000)
        expect_stage(page, "初期化フェーズ")
        expect_no_participants(page)
        expect_no_selection(page)
    finally:
        page.close()


@pytest.fixture
def frontend_page(browser: Browser, server_url: str) -> Iterator[Page]:
    context = browser.new_context(base_url=server_url)
    reset_game(context)
    context.add_init_script(
        """
        (() => {
          const events = [];
          window.__introBuzzAudioEvents = events;
          class FakeAudioContext {
            constructor() {
              this.currentTime = 0;
              this.state = 'running';
              this.destination = {};
              events.push({ type: 'context' });
            }
            createGain() {
              return {
                gain: {
                  setValueAtTime(value, time) { events.push({ type: 'gain.set', value, time }); },
                  exponentialRampToValueAtTime(value, time) { events.push({ type: 'gain.ramp', value, time }); },
                },
                connect() { events.push({ type: 'gain.connect' }); },
              };
            }
            createOscillator() {
              const oscillator = {
                type: 'sine',
                frequency: {
                  setValueAtTime(frequency, time) { events.push({ type: 'frequency', frequency, time }); },
                },
                connect() { events.push({ type: 'oscillator.connect', oscillatorType: oscillator.type }); },
                start(time) { events.push({ type: 'oscillator.start', oscillatorType: oscillator.type, time }); },
                stop(time) { events.push({ type: 'oscillator.stop', oscillatorType: oscillator.type, time }); },
              };
              return oscillator;
            }
            resume() {
              this.state = 'running';
              events.push({ type: 'resume' });
              return Promise.resolve();
            }
            close() {
              events.push({ type: 'close' });
              return Promise.resolve();
            }
          }
          window.AudioContext = FakeAudioContext;
          window.webkitAudioContext = FakeAudioContext;
        })();
        """
    )
    page = context.new_page()
    request_log: list[dict[str, str]] = []
    response_log: list[dict[str, str | int]] = []
    setattr(page, "request_log", request_log)
    setattr(page, "response_log", response_log)
    page.on("request", lambda request: request_log.append({"method": request.method, "url": request.url}))
    page.on("response", lambda response: response_log.append({"status": response.status, "url": response.url}))
    prepare_page(page)
    try:
        yield page
    finally:
        context.close()
