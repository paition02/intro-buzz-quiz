from __future__ import annotations

import os
import shutil
from typing import Iterator

import pytest
from playwright.sync_api import Browser, Error as PlaywrightError, Page, Playwright, sync_playwright

from frontend.musickit_mock import configure_musickit_api_mock, make_developer_token
from tls_helpers import chromium_certificate_args


@pytest.fixture(scope="session")
def playwright_instance() -> Iterator[Playwright]:
    with sync_playwright() as playwright:
        yield playwright


@pytest.fixture(scope="session")
def browser(playwright_instance: Playwright, server_url: str) -> Iterator[Browser]:
    launch_options = {
        "headless": True,
        "args": ["--no-sandbox", "--disable-dev-shm-usage", *chromium_certificate_args(server_url)],
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


@pytest.fixture
def frontend_page(browser: Browser, server_url: str, socket_client) -> Iterator[Page]:
    context = browser.new_context(base_url=server_url)
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
    configure_musickit_api_mock(page)
    page.route(
        "**/api/token",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json_token_response(),
        ),
    )
    try:
        yield page
    finally:
        context.close()
