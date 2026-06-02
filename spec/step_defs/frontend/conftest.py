from __future__ import annotations

import os
import shutil
from typing import Iterator

import pytest
from playwright.sync_api import Browser, Error as PlaywrightError, Page, Playwright, sync_playwright

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


@pytest.fixture
def frontend_page(browser: Browser, server_url: str, socket_client) -> Iterator[Page]:
    context = browser.new_context(base_url=server_url)
    page = context.new_page()
    request_log: list[dict[str, str]] = []
    response_log: list[dict[str, str | int]] = []
    setattr(page, "request_log", request_log)
    setattr(page, "response_log", response_log)
    page.on("request", lambda request: request_log.append({"method": request.method, "url": request.url}))
    page.on("response", lambda response: response_log.append({"status": response.status, "url": response.url}))
    page.add_init_script(
        """
        (() => {
          const calls = [];
          const summarize = (name, payload = {}) => {
            if (name === 'setQueue') return { songs: payload?.songs ?? [], startPlaying: payload?.startPlaying };
            if (name === 'changeToMediaAtIndex') return { index: payload };
            if (name === 'seekToTime') return { time: payload };
            if (name === 'configure') return { developerToken: payload?.developerToken, app: payload?.app };
            return payload;
          };
          const record = (name, payload = {}) => calls.push({ name, payload: summarize(name, payload), at: Date.now() });
          window.__musicKitObserver = { calls };
          let value;
          const patchInstance = (mk) => {
            if (!mk) return mk;
            window.__musicKitObserver.instance = mk;
            if (mk.__introBuzzInstanceObserved) return mk;
            const wrap = (method) => {
              if (typeof mk[method] !== 'function' || mk[method].__introBuzzObserved) return;
              const original = mk[method].bind(mk);
              const observed = (...args) => {
                record(method, args.length === 1 ? args[0] : args);
                return original(...args);
              };
              observed.__introBuzzObserved = true;
              Object.defineProperty(mk, method, {
                configurable: true,
                writable: true,
                value: observed,
              });
            };
            ['authorize', 'unauthorize', 'setQueue', 'changeToMediaAtIndex', 'seekToTime', 'play', 'pause', 'addEventListener', 'removeEventListener'].forEach(wrap);
            mk.__introBuzzInstanceObserved = true;
            return mk;
          };
          const patch = () => {
            if (!value || typeof value.configure !== 'function' || value.__introBuzzObserved) return;
            const originalConfigure = value.configure.bind(value);
            value.configure = (config) => {
              record('configure', config);
              const configured = originalConfigure(config);
              Promise.resolve(configured).then((mk) => patchInstance(mk ?? value.getInstance?.()));
              return configured;
            };
            const originalGetInstance = typeof value.getInstance === 'function' ? value.getInstance.bind(value) : null;
            if (originalGetInstance) {
              value.getInstance = (...args) => patchInstance(originalGetInstance(...args));
            }
            value.__introBuzzObserved = true;
          };
          Object.defineProperty(window, 'MusicKit', {
            configurable: true,
            get() { patch(); return value; },
            set(next) { value = next; patch(); },
          });
        })();
        """
    )
    configure_musickit_api_mock(page)
    page.route(
        "**/api/token",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json_token_response(),
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
