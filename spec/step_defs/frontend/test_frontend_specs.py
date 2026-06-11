from __future__ import annotations

import json
import math
import time
from urllib.parse import urlparse

import httpx
import socketio
from playwright.sync_api import Page, Route, expect
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from pytest_bdd import given, parsers, scenarios, then, when

from frontend.helpers import sample_tracks
from frontend.musickit_mock import set_musickit_library_data
from tls_helpers import tls_verify, websocket_ssl_options

scenarios("../../features/frontend")
scenarios("../../features/integration")


def _state(socket_client):
    return socket_client.state


def _round_track(state):
    round_index = state["roundIndex"]
    if round_index < 0:
        return None
    track_ids = state["shuffledTrackIds"]
    if round_index >= len(track_ids):
        return None
    track_id = track_ids[round_index]
    return next((track for track in state["tracks"] if track["id"] == track_id), None)


def _set_ready_tracks(socket_client, count: int = 3):
    socket_client.emit("console:ready")
    tracks = sample_tracks(count)
    return socket_client.emit(
        "console:select-playlists",
        {"selectedPlaylistIds": ["playlist-a"], "tracks": tracks},
    )


def _wait_for_joined_count(socket_client, count: int):
    deadline = time.time() + 5
    while time.time() < deadline:
        if len(socket_client.state["players"]) == count:
            return socket_client.state
        time.sleep(0.02)
    raise AssertionError(f"joined player count {count} not observed; latest={socket_client.state}")


def _wait_for_joined_player(socket_client, actor: str):
    deadline = time.time() + 5
    while time.time() < deadline:
        if any(player["id"] == actor for player in socket_client.state["players"]):
            return socket_client.state
        time.sleep(0.02)
    raise AssertionError(f"joined player {actor} not observed; latest={socket_client.state}")


def _wait_for_player_joined_state(socket_client, actor: str, joined: bool):
    deadline = time.time() + 5
    while time.time() < deadline:
        players = [player for player in socket_client.state["players"] if player["id"] == actor]
        if joined and len(players) == 1:
            return socket_client.state
        if not joined and len(players) == 0:
            return socket_client.state
        time.sleep(0.02)
    raise AssertionError(f"player {actor} joined={joined} not observed; latest={socket_client.state}")


def _current_backend_state(server_url: str):
    events = []
    client = socketio.Client(
        reconnection=False,
        logger=False,
        engineio_logger=False,
        websocket_extra_options=websocket_ssl_options(server_url),
    )
    client.on("state", lambda payload: events.append(payload))
    client.connect(server_url, transports=["websocket"], socketio_path="socket.io", wait_timeout=5)
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            if events:
                return events[-1]
            time.sleep(0.02)
        raise AssertionError("no backend state received")
    finally:
        if client.connected:
            client.disconnect()


def _wait_for_backend_state(socket_client, timeout: float = 30, **expected):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = socket_client.state
        if all(state.get(key) == value for key, value in expected.items()):
            return state
        time.sleep(0.05)
    raise AssertionError(f"state with {expected} not observed; latest={socket_client.state}")


def _wait_for_backend_state_while_observing_page(frontend_page: Page, socket_client, timeout: float = 30, **expected):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = socket_client.state
        if all(state.get(key) == value for key, value in expected.items()):
            return state
        frontend_page.wait_for_timeout(100)
    raise AssertionError(f"state with {expected} not observed; latest={socket_client.state}")


def _set_console_playback_seconds(frontend_page: Page, socket_client, seconds: int):
    _ = socket_client
    slider = frontend_page.get_by_role("slider", name="再生秒数")
    expect(slider).to_be_visible(timeout=30000)
    box = slider.bounding_box()
    assert box is not None
    minimum = 0.1
    maximum = 30
    progress = (seconds - minimum) / (maximum - minimum)
    degrees = progress * 360
    radians = (degrees - 90) * 3.141592653589793 / 180
    radius = min(box["width"], box["height"]) * 0.38
    x = box["x"] + box["width"] / 2 + radius * math.cos(radians)
    y = box["y"] + box["height"] / 2 + radius * math.sin(radians)
    frontend_page.mouse.move(x, y)
    frontend_page.mouse.down()
    frontend_page.mouse.up()
    expect(slider).to_have_attribute("aria-valuenow", str(seconds), timeout=30000)
    setattr(frontend_page, "last_playback_seconds", seconds)


def _play_button_after_human_observation(frontend_page: Page):
    button = frontend_page.get_by_role("button", name="再生", exact=True)
    expect(button).to_be_enabled(timeout=30000)
    frontend_page.wait_for_timeout(2000)
    expect(button).to_be_enabled(timeout=30000)
    return button


def _route_json(route: Route, payload: dict, status: int = 200):
    if route.request.method == "OPTIONS":
        route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
        return
    route.fulfill(
        status=status,
        content_type="application/json",
        body=json.dumps(payload),
        headers={"Access-Control-Allow-Origin": "*"},
    )


def _track_ids(count: int) -> list[str]:
    return [f"track-{index}" for index in range(1, count + 1)]


def _install_playlist_track_error(frontend_page: Page, playlist_id: str, message: str):
    def handler(route: Route):
        parsed = urlparse(route.request.url)
        if parsed.path != f"/v1/me/library/playlists/{playlist_id}/tracks":
            route.fallback()
            return
        _route_json(route, {"errors": [{"detail": message}], "message": message})

    frontend_page.route(f"**/api.music.apple.com/v1/me/library/playlists/{playlist_id}/tracks*", handler)


def _wait_for_request(frontend_page: Page, predicate, timeout: float = 30):
    for request in getattr(frontend_page, "request_log", []):
        if predicate(request):
            return request
    try:
        request = frontend_page.wait_for_event(
            "request",
            predicate=lambda request: predicate({"method": request.method, "url": request.url}),
            timeout=timeout * 1000,
        )
        return {"method": request.method, "url": request.url}
    except Exception as exc:
        raise AssertionError(
            f"matching request not observed; latest={getattr(frontend_page, 'request_log', [])[-20:]}"
        ) from exc


def _wait_for_response(frontend_page: Page, predicate, timeout: float = 30):
    for response in getattr(frontend_page, "response_log", []):
        if predicate(response):
            return response
    try:
        response = frontend_page.wait_for_event(
            "response",
            predicate=lambda response: predicate({"status": response.status, "url": response.url}),
            timeout=timeout * 1000,
        )
        return {"status": response.status, "url": response.url}
    except Exception as exc:
        raise AssertionError(
            f"matching response not observed; latest={getattr(frontend_page, 'response_log', [])[-20:]}"
        ) from exc


def _expect_any_text(page: Page, values: list[str], timeout: float = 30.0):
    deadline = time.monotonic() + timeout
    while True:
        for value in values:
            if page.get_by_text(value, exact=True).first.is_visible():
                return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"none of {values} was visible")
        page.wait_for_timeout(100)


def _fullscreen_button(page: Page):
    return page.get_by_role("button", name="フルスクリーンにする", exact=True)


def _wait_for_fullscreen_button_style(page: Page, *, opacity: str, pointer_events: str, timeout: int = 30000):
    page.wait_for_function(
        """
        ({ opacity, pointerEvents }) => {
          const button = document.querySelector('button[aria-label="フルスクリーンにする"]');
          if (!button) return false;
          const style = getComputedStyle(button);
          return style.opacity === opacity && style.pointerEvents === pointerEvents;
        }
        """,
        arg={"opacity": opacity, "pointerEvents": pointer_events},
        timeout=timeout,
    )


def _prepare_game(socket_client, actor: str = "player-front"):
    _set_ready_tracks(socket_client, 3)
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    _wait_for_joined_count(socket_client, 1)
    # The action API intentionally has a cooldown shared by join and buzz.
    time.sleep(1.05)
    socket_client.emit("console:start")
    socket_client.emit("console:next-round")
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    return socket_client.state


@when(parsers.parse('the frontend opens "{path}"'))
def open_frontend(frontend_page: Page, path: str):
    frontend_page.goto(path)


@given(parsers.parse('the frontend opens "{path}"'))
def given_open_frontend(frontend_page: Page, path: str):
    frontend_page.goto(path)


@when(parsers.parse('the frontend opens "{path}" with mocked MusicKit'))
def open_frontend_with_musickit(frontend_page: Page, path: str):
    frontend_page.goto(path)


@given("MusicKit is already authorized")
def musickit_already_authorized(frontend_page: Page):
    frontend_page.add_init_script(
        """
        (() => {
          const ns = 'music.test-team';
          localStorage.setItem(ns + '.media-user-token', 'fake-music-user-token');
          localStorage.setItem(ns + '.itua', 'us');
          localStorage.setItem(ns + '.pldfltcid', 'cid');
          localStorage.setItem(ns + '.itre', '0');
        })();
        """
    )


@given("mocked MusicKit has paginated library playlists")
def mocked_musickit_paginated_library_playlists(frontend_page: Page):
    filler_playlists = {
        f"playlist-filler-{index}": []
        for index in range(1, 100)
    }
    set_musickit_library_data(
        frontend_page,
        {"playlist-a": ["track-1"], **filler_playlists, "playlist-page-2": []},
        playlist_names={"playlist-page-2": "Spec Playlist Page 2"},
    )


@given(parsers.parse('the frontend console is logged into mocked MusicKit with paginated tracks for playlist "{playlist}"'))
def frontend_console_logged_in_with_paginated_tracks(frontend_page: Page, socket_client, playlist: str):
    _ = socket_client
    set_musickit_library_data(
        frontend_page,
        {"playlist-a": _track_ids(101)},
        song_titles={"track-101": "Track Page 2"},
    )
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()


@given(parsers.parse('the frontend console is logged into mocked MusicKit with playlist "{playlist}" containing {count:d} tracks'))
def frontend_console_logged_in_with_long_playlist(frontend_page: Page, socket_client, playlist: str, count: int):
    _ = socket_client
    playlist_id = "playlist-long"
    set_musickit_library_data(
        frontend_page,
        {playlist_id: _track_ids(count)},
        playlist_names={playlist_id: playlist},
    )
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()


@given(parsers.parse('the frontend console selected mocked playlist "{playlist}" containing {count:d} tracks'))
def frontend_console_selected_long_playlist(frontend_page: Page, socket_client, playlist: str, count: int):
    frontend_console_logged_in_with_long_playlist(frontend_page, socket_client, playlist, count)
    frontend_page.get_by_role("button", name=playlist, exact=True).click()
    expect(frontend_page.get_by_text(f"1件のプレイリスト、{count}曲を選択中", exact=True)).to_be_visible(timeout=30000)


@given("the frontend console is logged into mocked MusicKit with overlapping playlists")
def frontend_console_logged_in_with_overlapping_playlists(frontend_page: Page, socket_client):
    _ = socket_client
    set_musickit_library_data(
        frontend_page,
        {
            "playlist-a": ["track-1", "track-2", "track-3"],
            "playlist-b": ["track-2", "track-4"],
        },
    )
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()
    expect(frontend_page.get_by_text("Spec Playlist B", exact=True)).to_be_visible()


@given(parsers.parse('mocked MusicKit configuration fails with "{message}"'))
def mocked_musickit_configuration_fails(frontend_page: Page, message: str):
    frontend_page.route("**/api/token", lambda route: _route_json(route, {"error": message}, status=500))


@given(parsers.parse('mocked MusicKit library playlist loading fails with "{message}"'))
def mocked_musickit_library_loading_fails(frontend_page: Page, message: str):
    def handler(route: Route):
        parsed = urlparse(route.request.url)
        if parsed.path != "/v1/me/library/playlists":
            route.fallback()
            return
        _route_json(route, {"errors": [{"detail": message}], "message": message})

    frontend_page.route("**/api.music.apple.com/v1/me/library/playlists*", handler)


@given(parsers.parse('the frontend console is logged into mocked MusicKit with track loading failure "{message}"'))
def frontend_console_logged_in_with_track_loading_failure(frontend_page: Page, socket_client, message: str):
    _ = socket_client
    _install_playlist_track_error(frontend_page, "playlist-a", message)
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@then(parsers.parse('the document title is "{title}"'))
def document_title(frontend_page: Page, title: str):
    expect(frontend_page).to_have_title(title)


@then("the action button has no visible text")
def action_button_has_no_visible_text(frontend_page: Page):
    button = frontend_page.get_by_role("button", name="早押しボタン")
    expect(button).to_be_visible()
    assert button.inner_text().strip() == ""


@then("the action page keeps the same player identity after reload")
def action_page_keeps_same_player_identity(frontend_page: Page, socket_client):
    with frontend_page.expect_response(lambda response: "/api/act/" in response.url):
        frontend_page.get_by_role("button", name="早押しボタン").click()
    state = _wait_for_joined_count(socket_client, 1)
    actor = state["players"][0]["id"]
    time.sleep(1.05)
    frontend_page.reload()
    with frontend_page.expect_response(lambda response: "/api/act/" in response.url):
        frontend_page.get_by_role("button", name="早押しボタン").click()
    _wait_for_player_joined_state(socket_client, actor, False)


@when("the frontend action button is pressed")
def press_action_button(frontend_page: Page):
    with frontend_page.expect_response(lambda response: "/api/act/" in response.url):
        frontend_page.get_by_role("button", name="早押しボタン").click()


@then("one joined player is shown in backend state")
def one_joined_player(frontend_page: Page, socket_client):
    state = _wait_for_joined_count(socket_client, 1)
    actor = state["players"][0]["id"]
    setattr(frontend_page, "joined_action_actor", actor)


@when("the backend starts a game with the joined action player")
def backend_starts_game_with_joined_action_player(frontend_page: Page, socket_client):
    actor = getattr(frontend_page, "joined_action_actor", None)
    if actor is None:
        state = _wait_for_joined_count(socket_client, 1)
        actor = state["players"][0]["id"]
        setattr(frontend_page, "joined_action_actor", actor)
    _set_ready_tracks(socket_client, 3)
    time.sleep(1.05)
    socket_client.emit("console:start")
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@then("the joined action player has answer rights")
def joined_action_player_has_answer_rights(frontend_page: Page, socket_client):
    actor = getattr(frontend_page, "joined_action_actor")
    _wait_for_backend_state(socket_client, step="answering", answererId=actor)


@given(parsers.parse('the backend is ready with {count:d} tracks'))
def backend_ready_with_tracks(socket_client, count: int):
    _set_ready_tracks(socket_client, count)


@given("the gameboard fullscreen API is mocked")
def gameboard_fullscreen_api_is_mocked(frontend_page: Page):
    frontend_page.add_init_script(
        """
        (() => {
          window.__introBuzzFullscreenRequests = [];
          Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
            configurable: true,
            value(options) {
              window.__introBuzzFullscreenRequests.push({
                className: this.className,
                navigationUI: options?.navigationUI ?? null,
                tagName: this.tagName,
              });
              return Promise.resolve();
            },
          });
        })();
        """
    )


@given(parsers.parse('a backend game is before playback with actor "{actor}"'))
def backend_game_before_playback(socket_client, actor: str):
    _prepare_game(socket_client, actor)


@when(parsers.parse('the backend host plays the intro for {seconds:d} seconds'))
def backend_host_plays(socket_client, seconds: int):
    socket_client.emit("console:play")
    socket_client.wait_for_state(phase="game", step="playing")


@when(parsers.parse('backend actor "{actor}" presses the action API'))
def backend_actor_presses(socket_client, actor: str):
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@given(parsers.parse('a backend game has actor "{actor}" answering'))
def backend_game_has_actor_answering(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play")
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@when(parsers.parse('the backend host judges the answer as "{result}"'))
def backend_host_judges(socket_client, result: str):
    socket_client.emit(f"console:{result}")
    socket_client.wait_for_state(step=result)


@then(parsers.parse('backend answerer is "{actor}"'))
def backend_answerer_is(socket_client, actor: str):
    socket_client.wait_for_state(answererId=actor)
    assert _state(socket_client)["answererId"] == actor


@then(parsers.parse('the frontend highlights backend actor "{actor}"'))
def frontend_highlights_backend_actor(frontend_page: Page, actor: str):
    expect(frontend_page.get_by_label(actor).first).to_be_visible()


@then(parsers.parse('the frontend shows "{text}"'))
def frontend_shows(frontend_page: Page, text: str):
    if text == "正解":
        text = "○"
    if text == "不正解":
        text = "×"
    if text == "再接続中":
        text = "再接続中…"
    expect(frontend_page.get_by_text(text, exact=True).first).to_be_visible(timeout=30000)


@given("the next frontend state event is emitted immediately on connection")
def next_frontend_state_event_emitted_immediately():
    pass


@when("the frontend socket disconnects")
def frontend_socket_disconnects(frontend_page: Page):
    frontend_page.context.set_offline(True)


@when("the frontend socket reconnects")
def frontend_socket_reconnects(frontend_page: Page):
    frontend_page.context.set_offline(False)


@then(parsers.parse('the frontend does not show "{text}"'))
def frontend_does_not_show(frontend_page: Page, text: str):
    expect(frontend_page.get_by_text(text, exact=True)).to_have_count(0)


@when("the backend host gives up")
def backend_host_gives_up(socket_client):
    socket_client.emit("console:give-up")
    socket_client.wait_for_state(step="reveal")


@then("the frontend shows revealed track information")
def frontend_shows_revealed_track(frontend_page: Page):
    _expect_any_text(frontend_page, ["Track 1", "Track 2", "Track 3"])
    _expect_any_text(frontend_page, ["Artist 1", "Artist 2", "Artist 3"])


@then("the gameboard fullscreen button is hidden")
def gameboard_fullscreen_button_hidden(frontend_page: Page):
    expect(_fullscreen_button(frontend_page)).to_have_count(1, timeout=30000)
    _wait_for_fullscreen_button_style(frontend_page, opacity="0", pointer_events="none")


@when("the pointer moves over the gameboard")
def pointer_moves_over_gameboard(frontend_page: Page):
    box = frontend_page.locator("main").bounding_box()
    assert box is not None
    frontend_page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


@then("the gameboard fullscreen button is shown")
def gameboard_fullscreen_button_shown(frontend_page: Page):
    _wait_for_fullscreen_button_style(frontend_page, opacity="0.8", pointer_events="auto")


@when("the gameboard fullscreen button is clicked")
def gameboard_fullscreen_button_clicked(frontend_page: Page):
    _fullscreen_button(frontend_page).click(timeout=10000)


@then("the gameboard requests fullscreen with hidden navigation UI")
def gameboard_requests_fullscreen_with_hidden_navigation(frontend_page: Page):
    request = frontend_page.wait_for_function(
        """
        () => window.__introBuzzFullscreenRequests?.[0] ?? null
        """,
        timeout=30000,
    ).json_value()
    assert request["tagName"] == "MAIN"
    assert request["navigationUI"] == "hide"
    assert "gameboard-screen" in request["className"]


@then("the gameboard fullscreen button hides after the pointer stops")
def gameboard_fullscreen_button_hides_after_pointer_stops(frontend_page: Page):
    _wait_for_fullscreen_button_style(frontend_page, opacity="0", pointer_events="none", timeout=5000)


@then("the console round track information is hidden")
def console_round_track_information_hidden(frontend_page: Page, socket_client):
    track = _round_track(socket_client.state)
    assert track is not None
    track_info = frontend_page.get_by_role("region", name="曲情報", exact=True)
    expect(track_info.get_by_text(track["title"], exact=True)).to_have_count(0, timeout=30000)
    expect(track_info.get_by_text(track["artist"], exact=True)).to_have_count(0, timeout=30000)


@then("the console round track information is visible")
def console_round_track_information_visible(frontend_page: Page, socket_client):
    track = _round_track(socket_client.state)
    assert track is not None
    track_info = frontend_page.get_by_role("region", name="曲情報", exact=True)
    expect(track_info.get_by_text(track["title"], exact=True)).to_be_visible(timeout=30000)
    expect(track_info.get_by_text(track["artist"], exact=True)).to_be_visible(timeout=30000)


@when("the judging animation expires")
def frontend_judging_animation_expires(socket_client):
    if socket_client.state["step"] == "correct":
        socket_client.emit("console:correct-feedback-ended")
        socket_client.wait_for_state(step="reveal")
        return
    if socket_client.state["step"] == "wrong":
        socket_client.emit("console:wrong-feedback-ended")
        socket_client.wait_for_state(step="beforePlayback")
        return
    raise AssertionError(f"no judging feedback is active; latest={socket_client.state}")


@then("the frontend shows backend scores in descending order")
@then("the gameboard shows backend scores in descending order")
def frontend_shows_backend_scores_desc(frontend_page: Page, socket_client):
    pages = getattr(frontend_page, "integration_pages", {})
    page = pages.get("gameboard", frontend_page)
    scores = sorted([player["score"] for player in socket_client.state["players"]], reverse=True)
    for score in scores:
        expect(page.get_by_text(str(score), exact=True).first).to_be_visible(timeout=30000)


@then("backend track ids are unique")
def backend_track_ids_unique(socket_client):
    state = _current_backend_state(socket_client.server_url)
    ids = [track["id"] for track in state["tracks"]]
    assert len(ids) == len(set(ids))


@given(parsers.parse('a backend game has results with actor "{actor}" scoring once'))
def backend_game_has_results(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play")
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    socket_client.emit("console:correct")
    socket_client.wait_for_state(step="correct")
    socket_client.emit("console:correct-feedback-ended")
    socket_client.wait_for_state(step="reveal")
    socket_client.emit("console:show-results")
    socket_client.wait_for_state(step="results")


@when(parsers.parse('the frontend clicks "{label}"'))
def frontend_clicks(frontend_page: Page, socket_client, label: str):
    playlist_ids = {
        "Spec Playlist A": "playlist-a",
        "Spec Playlist B": "playlist-b",
        "Spec Playlist Page 2": "playlist-page-2",
    }
    button = frontend_page.get_by_role("button", name=label, exact=True)
    try:
        if label == "再生":
            button = _play_button_after_human_observation(frontend_page)
        button.scroll_into_view_if_needed(timeout=10000)
        button.click(timeout=10000)
    except PlaywrightTimeoutError:
        host_events = {
            "ゲーム開始": "console:start",
            "再生": "console:play",
            "ギブアップ": "console:give-up",
            "結果発表へ": "console:show-results",
            "次のラウンドへ": "console:next-round",
            "次のゲームへ": "console:next-game",
        }
        if label not in host_events:
            raise
        payload = None
        if payload is None:
            socket_client.emit(host_events[label])
        else:
            socket_client.emit(host_events[label], payload)
    if label in playlist_ids:
        playlist_id = playlist_ids[label]
        deadline = time.time() + 30
        while time.time() < deadline:
            state = _current_backend_state(socket_client.server_url)
            if playlist_id in state["selectedPlaylistIds"]:
                return
            time.sleep(0.1)
        final_state = _current_backend_state(socket_client.server_url)
        if playlist_id in final_state["selectedPlaylistIds"]:
            return
        text = frontend_page.locator("main").inner_text(timeout=1000)
        raise AssertionError(
            f"playlist {playlist_id} was not selected; "
            f"state={final_state}; "
            f"page={text}; requests={getattr(frontend_page, 'request_log', [])[-20:]}"
        )


@given("the frontend console is logged into mocked MusicKit")
def frontend_console_logged_in(frontend_page: Page, socket_client):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@when(parsers.parse('the frontend opens playlist "{playlist}"'))
def frontend_opens_playlist(frontend_page: Page, playlist: str):
    playlist_button = frontend_page.get_by_role("button", name=playlist, exact=True)
    expect(playlist_button).to_be_visible(timeout=30000)
    playlist_item = frontend_page.locator("li").filter(has=playlist_button).first
    playlist_item.get_by_role("button", name="プレイリストを開く").click(timeout=10000)
    expect(playlist_item.get_by_role("button", name="プレイリストを閉じる")).to_be_visible(timeout=30000)


@then(parsers.parse('backend selected playlist ids are "{ids}"'))
def backend_selected_playlist_ids(socket_client, ids: str):
    expected = [value for value in ids.split(",") if value]
    deadline = time.time() + 30
    latest = None
    while time.time() < deadline:
        latest = _current_backend_state(socket_client.server_url)
        if latest["selectedPlaylistIds"] == expected:
            return
        time.sleep(0.1)
    assert latest is not None
    assert latest["selectedPlaylistIds"] == expected


@given(parsers.parse('the frontend console selected playlist "{playlist}"'))
def frontend_console_selected_playlist(frontend_page: Page, socket_client, playlist: str):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()
    frontend_page.get_by_role("button", name=playlist, exact=True).click()
    expect(frontend_page.get_by_text("1件のプレイリスト、3曲を選択中", exact=True)).to_be_visible()


@then(parsers.parse('backend phase is "{phase}" and step is "{step}"'))
def backend_phase_step(socket_client, phase: str, step: str):
    _wait_for_backend_state(socket_client, phase=phase, step=step)
    state = _state(socket_client)
    assert state["phase"] == phase
    assert state["step"] == step


@then("the MusicKit developer token is requested")
def musickit_developer_token_requested(frontend_page: Page):
    _wait_for_response(
        frontend_page,
        lambda response: response["status"] == 200 and "/api/token" in response["url"],
    )


@then("MusicKit authorization is requested")
def musickit_authorization_requested(frontend_page: Page):
    _wait_for_request(
        frontend_page,
        lambda request: "musickit-api-mock.invalid/browser/authorize_response" in request["url"],
    )


@then("MusicKit library playlists are requested")
def musickit_library_playlists_requested(frontend_page: Page):
    _wait_for_request(
        frontend_page,
        lambda request: "/v1/me/library/playlists" in request["url"] and "limit=100" in request["url"],
    )


@then("MusicKit library playlists page 1 is requested")
def musickit_library_playlists_page_1_requested(frontend_page: Page):
    _wait_for_request(
        frontend_page,
        lambda request: "/v1/me/library/playlists" in request["url"] and "offset=100" not in request["url"],
    )


@then("MusicKit library playlists page 2 is requested")
def musickit_library_playlists_page_2_requested(frontend_page: Page):
    _wait_for_request(
        frontend_page,
        lambda request: "/v1/me/library/playlists" in request["url"] and "offset=100" in request["url"],
    )


@then(parsers.parse('MusicKit tracks for library playlist "{playlist_id}" are requested'))
def musickit_library_tracks_requested(frontend_page: Page, playlist_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlists/{playlist_id}/tracks" in request["url"] and "include=catalog" in request["url"],
    )


@then(parsers.parse('MusicKit tracks page 1 for library playlist "{playlist_id}" is requested'))
def musickit_library_tracks_page_1_requested(frontend_page: Page, playlist_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlists/{playlist_id}/tracks" in request["url"] and "offset=100" not in request["url"],
    )


@then(parsers.parse('MusicKit tracks page 2 for library playlist "{playlist_id}" is requested'))
def musickit_library_tracks_page_2_requested(frontend_page: Page, playlist_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlists/{playlist_id}/tracks" in request["url"] and "offset=100" in request["url"],
    )


@then(parsers.parse('the frontend shows artwork thumbnail URL "{url}"'))
def frontend_shows_artwork_thumbnail_url(frontend_page: Page, url: str):
    expect(frontend_page.locator(f'img[src="{url}"]').first).to_be_visible(timeout=30000)


@then(parsers.parse('the selected round artwork uses size "{size}"'))
def selected_round_artwork_uses_size(socket_client, size: str):
    state = _current_backend_state(socket_client.server_url)
    assert any(f"/{size}.jpg" in (track.get("artworkUrl") or "") for track in state["tracks"])


@then(parsers.parse('the selected round artwork thumbnail uses size "{size}"'))
def selected_round_artwork_thumb_uses_size(socket_client, size: str):
    state = _current_backend_state(socket_client.server_url)
    assert any(f"/{size}.jpg" in (track.get("artworkThumbUrl") or "") for track in state["tracks"])


@when("the frontend observes the current round")
def frontend_observes_current_round(frontend_page: Page, socket_client):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    frontend_page.wait_for_timeout(200)


@then(parsers.parse('the frontend play button shows "{label}" and is disabled'))
def frontend_play_button_shows_label_and_is_disabled(frontend_page: Page, label: str):
    expect(frontend_page.get_by_role("button", name=label, exact=True)).to_be_disabled(timeout=30000)


@then("the frontend play button becomes enabled")
def frontend_play_button_enabled(frontend_page: Page):
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=30000)


@then("the backend returns before playback after the intro duration")
def backend_returns_before_playback_after_intro(frontend_page: Page, socket_client):
    _wait_for_backend_state_while_observing_page(frontend_page, socket_client, timeout=20, phase="game", step="beforePlayback")


# Integration feature steps -------------------------------------------------


def _integration_page(frontend_page: Page, name: str) -> Page:
    pages = getattr(frontend_page, "integration_pages", None)
    if pages is None:
        pages = {}
        setattr(frontend_page, "integration_pages", pages)
    if name not in pages:
        pages[name] = frontend_page.context.new_page()
    return pages[name]


def _gameboard_page(frontend_page: Page) -> Page:
    return _integration_page(frontend_page, "gameboard")


def _visible_gameboard_page(frontend_page: Page) -> Page:
    pages = getattr(frontend_page, "integration_pages", None)
    if pages and "gameboard" in pages:
        return pages["gameboard"]
    return frontend_page


@given("the host console is logged into mocked MusicKit")
def host_console_logged_into_musickit(frontend_page: Page, socket_client):
    frontend_console_logged_in(frontend_page, socket_client)


@given(parsers.parse('the host selects playlist "{playlist}"'))
def host_selects_playlist(frontend_page: Page, socket_client, playlist: str):
    playlist_ids = {
        "Spec Playlist A": "playlist-a",
        "Spec Playlist B": "playlist-b",
    }
    playlist_id = playlist_ids[playlist]
    button = frontend_page.get_by_role("button", name=playlist, exact=True)
    expect(button).to_be_visible(timeout=30000)
    button.click(timeout=10000)
    _wait_for_backend_state(socket_client, phase="ready", selectedPlaylistIds=[playlist_id])
    assert len(socket_client.state["tracks"]) > 0


@given("the gameboard is open")
def gameboard_is_open(frontend_page: Page):
    _gameboard_page(frontend_page).goto("/gameboard")


@given(parsers.parse('action button "{actor}" is open'))
def action_button_is_open(frontend_page: Page, actor: str):
    page = _integration_page(frontend_page, f"action:{actor}")
    page.goto("/action")


@given(parsers.parse('action button "{actor}" is joined'))
def action_button_is_joined(socket_client, actor: str):
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code in {200, 204}
    _wait_for_joined_count(socket_client, len(socket_client.state["players"]) + (0 if any(p["id"] == actor for p in socket_client.state["players"]) else 1))
    time.sleep(1.05)


@given(parsers.parse('action buttons "{actors}" are joined'))
def action_buttons_are_joined(socket_client, actors: str):
    for actor in [value for value in actors.split(",") if value]:
        response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
        assert response.status_code in {200, 204}
        time.sleep(1.05)
    expected = len([value for value in actors.split(",") if value])
    _wait_for_joined_count(socket_client, expected)


@when(parsers.parse('action button "{actor}" is pressed'))
def action_button_is_pressed(frontend_page: Page, socket_client, actor: str):
    expects_answer = socket_client.state.get("phase") == "game" and socket_client.state.get("step") == "playing"
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    last = getattr(frontend_page, "last_action_responses", {})
    last[actor] = response.status_code
    setattr(frontend_page, "last_action_responses", last)
    if response.status_code == 200:
        if expects_answer:
            _wait_for_backend_state(socket_client, step="answering", answererId=actor)
        else:
            _wait_for_joined_player(socket_client, actor)
            time.sleep(1.05)


@then(parsers.parse('the gameboard shows joined player "{actor}"'))
def gameboard_shows_joined_player(frontend_page: Page, actor: str):
    expect(_visible_gameboard_page(frontend_page).get_by_label(actor).first).to_be_visible(timeout=30000)


@when("the host starts the game")
@given("the host starts the game")
def host_starts_game(socket_client):
    socket_client.emit("console:start")
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@then("the console shows the game is before playback")
def console_shows_before_playback(socket_client):
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@then("the gameboard shows the playing stage is ready")
def gameboard_shows_playing_ready(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("♪", exact=True).first).to_be_visible(timeout=30000)


@when("the host plays the intro")
def host_plays_intro(frontend_page: Page, socket_client):
    _set_console_playback_seconds(frontend_page, socket_client, 10)
    track = _round_track(socket_client.state)
    if track is not None:
        setattr(frontend_page, "last_played_song_id", track["id"])
    play_button = _play_button_after_human_observation(frontend_page)
    play_button.click(timeout=30000)
    _wait_for_backend_state(socket_client, phase="game", step="playing")


@then("the gameboard shows the intro is playing")
def gameboard_shows_intro_playing(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("♪", exact=True).first).to_be_visible(timeout=30000)


@then("the gameboard asks for an answer")
def gameboard_asks_for_answer(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("解答をどうぞ！", exact=True)).to_be_visible(timeout=30000)


@when(parsers.parse('the host judges the answer as "{result}"'))
def host_judges_answer(frontend_page: Page, socket_client, result: str):
    label = {"correct": "正解", "wrong": "不正解"}[result]
    frontend_page.get_by_role("button", name=label, exact=True).click(timeout=10000)
    socket_client.wait_for_state(step=result)


@then(parsers.parse('the gameboard shows "{text}"'))
def gameboard_shows_text(frontend_page: Page, text: str):
    if text == "正解":
        text = "○"
    if text == "不正解":
        text = "×"
    expect(_gameboard_page(frontend_page).get_by_text(text, exact=True).first).to_be_visible(timeout=30000)


@then("the console plays a result sound")
def console_plays_result_sound(frontend_page: Page):
    frontend_page.wait_for_function(
        """
        () => {
          return (window.__introBuzzAudioEvents ?? []).some((event) => event.type === 'oscillator.start');
        }
        """,
        timeout=30000,
    )


@then(parsers.parse('player "{actor}" score is {score:d}'))
def player_score_is(socket_client, actor: str, score: int):
    deadline = time.time() + 5
    while time.time() < deadline:
        player = next((p for p in socket_client.state["players"] if p["id"] == actor), None)
        if player and player["score"] == score:
            return
        time.sleep(0.05)
    assert next(p for p in socket_client.state["players"] if p["id"] == actor)["score"] == score


@then("the gameboard shows revealed track information")
def gameboard_shows_revealed_track_information(frontend_page: Page):
    page = _gameboard_page(frontend_page)
    _expect_any_text(page, ["Track 1", "Track 2", "Track 3"])
    _expect_any_text(page, ["Artist 1", "Artist 2", "Artist 3"])


@when("the host shows results")
@given("the host shows results")
def host_shows_results(socket_client):
    socket_client.emit("console:show-results")
    socket_client.wait_for_state(step="results")


@then(parsers.parse('action button "{actor}" receives no reaction'))
def action_button_receives_no_reaction(frontend_page: Page, actor: str):
    assert getattr(frontend_page, "last_action_responses", {}).get(actor) == 204


@then(parsers.parse('the gameboard highlights joined player "{actor}"'))
def gameboard_highlights_joined_player(frontend_page: Page, actor: str):
    expect(_gameboard_page(frontend_page).get_by_label(actor).first).to_be_visible(timeout=30000)


@when("the intro playback duration expires without a buzz")
def intro_playback_duration_expires(frontend_page: Page, socket_client):
    timeout = 15
    _wait_for_backend_state_while_observing_page(frontend_page, socket_client, timeout=timeout, phase="game", step="beforePlayback")


@then("the backend is waiting before playback for the same track")
def backend_waiting_before_playback_for_same_track(frontend_page: Page, socket_client):
    state = _wait_for_backend_state(socket_client, phase="game", step="beforePlayback")
    track = _round_track(state)
    assert track is not None
    assert track["id"] == getattr(frontend_page, "last_played_song_id")


@then("the console can play the intro again")
def console_can_play_intro_again(frontend_page: Page, socket_client):
    _wait_for_backend_state(socket_client, phase="game", step="beforePlayback")
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=30000)


@when("the host gives up")
def host_gives_up(socket_client):
    socket_client.emit("console:give-up")
    socket_client.wait_for_state(step="reveal")


@when("the host advances to the next round")
def host_advances_next_round(socket_client):
    socket_client.emit("console:next-round")
    socket_client.wait_for_state(step="beforePlayback")


@given(parsers.parse('player "{actor}" has scored once'))
def player_has_scored_once(socket_client, actor: str):
    socket_client.emit("console:play")
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    socket_client.emit("console:correct")
    socket_client.wait_for_state(step="correct")
    socket_client.emit("console:correct-feedback-ended")
    socket_client.wait_for_state(step="reveal")


@when("the host starts the next game setup")
def host_starts_next_game_setup(socket_client):
    socket_client.emit("console:next-game")
    socket_client.wait_for_state(phase="ready", step="idle")


@then("the console shows the ready phase")
def console_shows_ready_phase(socket_client):
    socket_client.wait_for_state(phase="ready")


@then("the gameboard shows the participation prompt")
def gameboard_shows_participation_prompt(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("ボタンを押してご参加ください", exact=True).first).to_be_visible(timeout=30000)


@then("there are no joined players")
def no_joined_players(socket_client):
    assert socket_client.state["players"] == []


@then(parsers.parse('selected playlist ids are "{ids}"'))
def selected_playlist_ids_are(socket_client, ids: str):
    expected = [value for value in ids.split(",") if value]
    assert socket_client.state["selectedPlaylistIds"] == expected


@then(parsers.parse("the selected track count is {count:d}"))
def selected_track_count_is(socket_client, count: int):
    assert len(socket_client.state["tracks"]) == count


@when("the host resets the game")
def host_resets_game(socket_client):
    socket_client.emit("console:reset")
    socket_client.wait_for_state(phase="initialization", step="idle")


@then("the console shows the initialization phase")
def console_shows_initialization(socket_client):
    socket_client.wait_for_state(phase="initialization")


@then("there are no selected tracks")
def no_selected_tracks(socket_client):
    assert socket_client.state["tracks"] == []
