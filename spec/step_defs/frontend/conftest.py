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
    page.add_init_script(
        """
        (() => {
          const calls = [];
          const initialMethodDelays = window.__introBuzzMusicKitDelayConfig ?? {};
          const initialAutoPlayAfterMethods = window.__introBuzzMusicKitAutoPlayAfterMethods ?? [];
          const summarize = (name, payload = {}) => {
            if (name === 'setQueue') return { songs: payload?.songs ?? [], startPlaying: payload?.startPlaying };
            if (name === 'changeToMediaAtIndex') return { index: payload };
            if (name === 'seekToTime') return { time: payload };
            if (name === 'configure') return { developerToken: payload?.developerToken, app: payload?.app };
            return payload;
          };
          const record = (name, payload = {}) => calls.push({ name, payload: summarize(name, payload), at: Date.now() });
          window.__musicKitObserver = { calls, methodDelays: initialMethodDelays, autoPlayAfterMethods: initialAutoPlayAfterMethods };
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
                const delay = Number(window.__musicKitObserver?.methodDelays?.[method] ?? 0);
                const autoPlayAfterMethods = window.__musicKitObserver?.autoPlayAfterMethods ?? [];
                const shouldAutoPlay = Array.isArray(autoPlayAfterMethods) && autoPlayAfterMethods.includes(method);
                const runOriginal = () => {
                  const result = original(...args);
                  if (!shouldAutoPlay) return result;
                  return Promise.resolve(result).then((value) => Promise.resolve(mk.play()).then(() => value));
                };
                if (!Number.isFinite(delay) || delay <= 0) return runOriginal();
                return new Promise((resolve) => setTimeout(resolve, delay)).then(runOriginal);
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
    try:
        yield page
    finally:
        context.close()
