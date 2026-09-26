from __future__ import annotations

import json
import math
import time
from urllib.parse import unquote, urlparse

import httpx
import socketio
from playwright.sync_api import Page, Route, expect
from pytest_bdd import given, parsers, scenarios, then, when

from frontend.helpers import sample_tracks
from frontend.musickit_mock import (
    library_song_id,
    set_musickit_library_albums,
    set_musickit_library_data,
    set_musickit_library_folders,
    set_musickit_library_song_albums,
)

scenarios(
    "../../features/frontend/console_page.feature",
    "../../features/frontend/action_page.feature",
    "../../features/frontend/apple_music.feature",
    "../../features/frontend/gameboard_page.feature",
    "../../features/integration/game_session.feature",
)


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
        socket_client.sleep(0.02)
    raise AssertionError(f"joined player count {count} not observed; latest={socket_client.state}")


def _wait_for_joined_player(socket_client, actor: str):
    deadline = time.time() + 5
    while time.time() < deadline:
        if any(player["id"] == actor for player in socket_client.state["players"]):
            return socket_client.state
        socket_client.sleep(0.02)
    raise AssertionError(f"joined player {actor} not observed; latest={socket_client.state}")


def _wait_for_player_joined_state(socket_client, actor: str, joined: bool):
    deadline = time.time() + 5
    while time.time() < deadline:
        players = [player for player in socket_client.state["players"] if player["id"] == actor]
        if joined and len(players) == 1:
            return socket_client.state
        if not joined and len(players) == 0:
            return socket_client.state
        socket_client.sleep(0.02)
    raise AssertionError(f"player {actor} joined={joined} not observed; latest={socket_client.state}")


def _current_backend_state(socket_client):
    server_url = socket_client.server_url
    events = []
    client = socketio.Client(
        reconnection=False,
        logger=False,
        engineio_logger=False,
    )
    client.on("state", lambda payload: events.append(payload))
    client.connect(server_url, transports=["websocket"], socketio_path="socket.io", wait_timeout=5)
    try:
        deadline = time.time() + 5
        while time.time() < deadline:
            if events:
                return events[-1]
            socket_client.sleep(0.02)
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
        socket_client.sleep(0.05)
    raise AssertionError(f"state with {expected} not observed; latest={socket_client.state}")


def _playback_seconds_slider(frontend_page: Page):
    slider = frontend_page.get_by_role("slider", name="再生秒数")
    expect(slider).to_be_visible(timeout=30000)
    return slider


def _playback_seconds_slider_point(frontend_page: Page, degrees: float, radius_ratio: float):
    slider = _playback_seconds_slider(frontend_page)
    slider.scroll_into_view_if_needed(timeout=10000)
    box = slider.bounding_box()
    assert box is not None
    radians = (degrees - 90) * math.pi / 180
    radius = min(box["width"], box["height"]) * radius_ratio
    return box["x"] + box["width"] / 2 + radius * math.cos(radians), box["y"] + box["height"] / 2 + radius * math.sin(radians)


def _press_playback_seconds_slider(frontend_page: Page, degrees: float, radius_ratio: float):
    x, y = _playback_seconds_slider_point(frontend_page, degrees, radius_ratio)
    frontend_page.mouse.move(x, y)
    frontend_page.mouse.down()
    frontend_page.mouse.up()
    return _playback_seconds_slider(frontend_page)


def _touch_swipe_up_on_playback_seconds_slider(frontend_page: Page, degrees: float, radius_ratio: float):
    frontend_page.set_viewport_size({"width": 390, "height": 600})
    x, y = _playback_seconds_slider_point(frontend_page, degrees, radius_ratio)
    setattr(frontend_page, "scroll_y_before_swipe", frontend_page.evaluate("window.scrollY"))
    session = frontend_page.context.new_cdp_session(frontend_page)
    session.send(
        "Input.synthesizeScrollGesture",
        {"x": x, "y": y, "xDistance": 0, "yDistance": -200, "gestureSourceType": "touch", "speed": 800},
    )
    session.detach()
    frontend_page.wait_for_timeout(500)


def _set_console_playback_seconds(frontend_page: Page, socket_client, seconds: int):
    _ = socket_client
    minimum = 0.1
    maximum = 30
    progress = (seconds - minimum) / (maximum - minimum)
    slider = _press_playback_seconds_slider(frontend_page, 20 + progress * 320, 0.38)
    expect(slider).to_have_attribute("aria-valuenow", str(seconds), timeout=30000)
    setattr(frontend_page, "last_playback_seconds", seconds)


def _ready_play_button(frontend_page: Page):
    button = frontend_page.get_by_role("button", name="再生", exact=True)
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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code == 200
    _wait_for_joined_count(socket_client, 1)
    # The action API intentionally has a cooldown shared by join and buzz.
    socket_client.sleep(1.05)
    socket_client.emit("console:start", {"quizMode": "intro"})
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


@given("secure-context-only web APIs are unavailable")
def secure_context_apis_unavailable(frontend_page: Page):
    # LAN の http (non-secure context) を再現する。localhost は常に secure context なので API を明示的に消す。
    frontend_page.add_init_script(
        """
        (() => {
          Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
          delete Crypto.prototype.randomUUID;
          delete Crypto.prototype.subtle;
          delete Navigator.prototype.wakeLock;
        })();
        """
    )


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
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()


def _log_in_console(frontend_page: Page):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@given('the frontend console is logged into mocked MusicKit with playlist "Spec Playlist B" in folder "Spec Folder"')
def frontend_console_logged_in_with_playlist_folder(frontend_page: Page, socket_client):
    _ = socket_client
    set_musickit_library_folders(
        frontend_page,
        root_children=["playlist-a", "folder-spec"],
        folders={"folder-spec": ("Spec Folder", ["playlist-b"])},
    )
    _log_in_console(frontend_page)


@given('the frontend console is logged into mocked MusicKit with playlist "Spec Playlist B" in subfolder "Spec Sub Folder" of folder "Spec Folder"')
def frontend_console_logged_in_with_playlist_subfolder(frontend_page: Page, socket_client):
    _ = socket_client
    set_musickit_library_folders(
        frontend_page,
        root_children=["folder-spec"],
        folders={
            "folder-spec": ("Spec Folder", ["playlist-a", "folder-sub"]),
            "folder-sub": ("Spec Sub Folder", ["playlist-b"]),
        },
    )
    _log_in_console(frontend_page)


@given('the frontend console is logged into mocked MusicKit with empty folder "Spec Empty Folder"')
def frontend_console_logged_in_with_empty_folder(frontend_page: Page, socket_client):
    _ = socket_client
    set_musickit_library_folders(
        frontend_page,
        root_children=["folder-empty", "playlist-a", "playlist-b"],
        folders={"folder-empty": ("Spec Empty Folder", [])},
    )
    _log_in_console(frontend_page)


@given('the frontend console is logged into mocked MusicKit with 101 playlists in folder "Spec Folder"')
def frontend_console_logged_in_with_paginated_folder(frontend_page: Page, socket_client):
    _ = socket_client
    folder_playlist_ids = [f"playlist-filler-{index}" for index in range(1, 101)] + ["playlist-page-2"]
    set_musickit_library_data(
        frontend_page,
        {"playlist-a": ["track-1"], **{playlist_id: [] for playlist_id in folder_playlist_ids}},
        playlist_names={"playlist-page-2": "Spec Playlist Page 2"},
    )
    set_musickit_library_folders(
        frontend_page,
        root_children=["folder-spec", "playlist-a"],
        folders={"folder-spec": ("Spec Folder", folder_playlist_ids)},
    )
    _log_in_console(frontend_page)


@when(parsers.parse('the frontend opens folder "{folder}"'))
def frontend_opens_folder(frontend_page: Page, folder: str):
    folder_button = frontend_page.get_by_role("button", name=folder, exact=True)
    expect(folder_button).to_be_visible(timeout=30000)
    # 親フォルダの li も子フォルダのボタンを含むので、同じ行の開閉ボタンをたどる。
    toggle = folder_button.locator("xpath=following-sibling::button")
    expect(toggle).to_have_accessible_name("フォルダを開く")
    toggle.click(timeout=10000)
    expect(toggle).to_have_accessible_name("フォルダを閉じる", timeout=30000)


@when(parsers.parse('the frontend searches playlists for "{text}"'))
def frontend_searches_playlists(frontend_page: Page, text: str):
    frontend_page.get_by_placeholder("プレイリスト名で検索").fill(text)


def _folder_children_requests(frontend_page: Page, folder_id: str):
    return [
        request
        for request in getattr(frontend_page, "request_log", [])
        if urlparse(request["url"]).path == f"/v1/me/library/playlist-folders/{folder_id}/children"
    ]


@then(parsers.parse('MusicKit children of library playlist folder "{folder_id}" are requested {count:d} times'))
def musickit_folder_children_requested_times(frontend_page: Page, folder_id: str, count: int):
    deadline = time.time() + 30
    while time.time() < deadline:
        if len(_folder_children_requests(frontend_page, folder_id)) == count:
            return
        frontend_page.wait_for_timeout(100)
    raise AssertionError(
        f"expected {count} children requests for {folder_id}; "
        f"got {len(_folder_children_requests(frontend_page, folder_id))}"
    )


@then(parsers.parse('MusicKit children page 2 of library playlist folder "{folder_id}" is requested'))
def musickit_folder_children_page_2_requested(frontend_page: Page, folder_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlist-folders/{folder_id}/children" in request["url"] and "offset=100" in request["url"],
    )


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
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()


@given(parsers.parse('the frontend console selected mocked playlist "{playlist}" containing {count:d} tracks'))
def frontend_console_selected_long_playlist(frontend_page: Page, socket_client, playlist: str, count: int):
    frontend_console_logged_in_with_long_playlist(frontend_page, socket_client, playlist, count)
    frontend_page.get_by_role("button", name=playlist, exact=True).click()
    expect(frontend_page.get_by_text(f"1件のプレイリスト、{count}曲を選択中", exact=True)).to_be_visible(timeout=30000)


@given(parsers.parse('the frontend console is logged into mocked MusicKit with playlist "{playlist}" on two library albums of one album'))
def frontend_console_logged_in_with_two_library_albums_of_one_album(frontend_page: Page, socket_client, playlist: str):
    _ = socket_client
    set_musickit_library_song_albums(
        frontend_page,
        {"l.release1": ["track-1", "track-2"], "l.release2": ["track-3"]},
        album_name="Shared Album",
        artist_name="Shared Artist",
    )
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()


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
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
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
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
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
    socket_client.sleep(1.05)
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
    socket_client.sleep(1.05)
    socket_client.emit("console:start", {"quizMode": "intro"})
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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@given(parsers.parse('a backend game has actor "{actor}" answering'))
def backend_game_has_actor_answering(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play")
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
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
    state = _current_backend_state(socket_client)
    ids = [track["id"] for track in state["tracks"]]
    assert len(ids) == len(set(ids))


@given(parsers.parse('a backend game has results with actor "{actor}" scoring once'))
def backend_game_has_results(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play")
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
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
    if label == "次のラウンドへ" and hasattr(frontend_page, "manifest_log"):
        _mark_advance(frontend_page)
    if label == "再生":
        button = _ready_play_button(frontend_page)
    button.scroll_into_view_if_needed(timeout=10000)
    button.click(timeout=10000)
    if label in playlist_ids:
        playlist_id = playlist_ids[label]
        deadline = time.time() + 30
        while time.time() < deadline:
            state = _current_backend_state(socket_client)
            if playlist_id in state["selectedPlaylistIds"]:
                return
            socket_client.sleep(0.1)
        final_state = _current_backend_state(socket_client)
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
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@when(parsers.parse('the frontend opens playlist "{playlist}"'))
def frontend_opens_playlist(frontend_page: Page, playlist: str):
    playlist_button = frontend_page.get_by_role("button", name=playlist, exact=True)
    expect(playlist_button).to_be_visible(timeout=30000)
    playlist_item = frontend_page.locator("li").filter(has=playlist_button).first
    playlist_item.get_by_role("button", name="プレイリストを開く").click(timeout=10000)
    expect(playlist_item.get_by_role("button", name="プレイリストを閉じる")).to_be_visible(timeout=30000)


@then("backend has no selected playlists")
def backend_has_no_selected_playlists(frontend_page: Page, socket_client):
    backend_selected_playlist_ids(frontend_page, socket_client, "")


@then(parsers.parse('backend selected playlist ids are "{ids}"'))
def backend_selected_playlist_ids(frontend_page: Page, socket_client, ids: str):
    expected = [value for value in ids.split(",") if value]
    deadline = time.time() + 30
    latest = None
    while time.time() < deadline:
        latest = _current_backend_state(socket_client)
        if latest["selectedPlaylistIds"] == expected:
            return
        socket_client.sleep(0.1)
    assert latest is not None
    assert latest["selectedPlaylistIds"] == expected


@given(parsers.parse('the frontend console selected playlist "{playlist}"'))
def frontend_console_selected_playlist(frontend_page: Page, socket_client, playlist: str):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text(playlist, exact=True)).to_be_visible()
    frontend_page.get_by_role("button", name=playlist, exact=True).click()
    expect(frontend_page.get_by_text("1件のプレイリスト、3曲を選択中", exact=True)).to_be_visible()


@then(parsers.parse('backend phase is "{phase}" and step is "{step}"'))
def backend_phase_step(socket_client, phase: str, step: str):
    _wait_for_backend_state(socket_client, phase=phase, step=step)
    state = _state(socket_client)
    assert state["phase"] == phase
    assert state["step"] == step


@then(parsers.parse('backend quiz mode is "{quiz_mode}"'))
def backend_quiz_mode(socket_client, quiz_mode: str):
    _wait_for_backend_state(socket_client, quizMode=quiz_mode)
    assert _state(socket_client)["quizMode"] == quiz_mode


@when(parsers.parse('the frontend selects jacket mode "{jacket_mode}"'))
def frontend_selects_jacket_mode(frontend_page: Page, socket_client, jacket_mode: str):
    frontend_page.get_by_role("combobox", name="隠し方").select_option(jacket_mode)
    _wait_for_backend_state(socket_client, jacketMode=jacket_mode)


@when("the frontend toggles jacket grayscale")
def frontend_toggles_jacket_grayscale(frontend_page: Page, socket_client):
    checkbox = frontend_page.get_by_role("checkbox", name="白黒")
    expect(checkbox).to_be_checked()
    checkbox.click()
    _wait_for_backend_state(socket_client, jacketGrayscale=False)


@when(parsers.parse("the frontend sets jacket hint percent to {percent:d}"))
def frontend_sets_jacket_hint_percent(frontend_page: Page, socket_client, percent: int):
    slider = frontend_page.get_by_role("slider", name="ヒントレベル")
    expect(slider).to_be_visible(timeout=30000)
    slider.focus()
    current = int(slider.get_attribute("aria-valuenow") or "1")
    key = "ArrowRight" if percent > current else "ArrowLeft"
    for _ in range(abs(percent - current)):
        frontend_page.keyboard.press(key)
        # Let server echoes interleave with the next key, exposing stale-value races.
        frontend_page.wait_for_timeout(5)
    _wait_for_backend_state(socket_client, jacketHintPercent=percent)


@then("the frontend shows jacket controls")
def frontend_shows_jacket_controls(frontend_page: Page):
    expect(frontend_page.get_by_role("combobox", name="隠し方")).to_be_visible(timeout=30000)
    expect(frontend_page.get_by_role("checkbox", name="白黒")).to_be_visible(timeout=30000)
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_be_visible(timeout=30000)


@then("the backend jacket settings match the frontend controls")
def backend_jacket_settings_match_frontend_controls(socket_client):
    state = socket_client.state
    assert state["jacketMode"] == "tileShuffle"
    assert state["jacketGrayscale"] is False
    assert state["jacketHintPercent"] == 12


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


@then("MusicKit library playlists page 2 is requested with their folders")
def musickit_library_playlists_page_2_requested_with_folders(frontend_page: Page):
    _wait_for_request(
        frontend_page,
        lambda request: urlparse(request["url"]).path == "/v1/me/library/playlists"
        and "offset=100" in request["url"]
        and "include=parent" in request["url"],
    )


@then(parsers.parse('MusicKit tracks for library playlist "{playlist_id}" are requested'))
def musickit_library_tracks_requested(frontend_page: Page, playlist_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlists/{playlist_id}/tracks" in request["url"] and "include=catalog" in request["url"],
    )


@then(parsers.parse('MusicKit tracks for library playlist "{playlist_id}" are requested with their library albums'))
def musickit_library_tracks_requested_with_albums(frontend_page: Page, playlist_id: str):
    _wait_for_request(
        frontend_page,
        lambda request: f"/v1/me/library/playlists/{playlist_id}/tracks" in request["url"]
        and "include=catalog,albums" in unquote(request["url"]),
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


@then("the frontend shows track chip artwork")
def frontend_shows_track_chip_artwork(frontend_page: Page):
    expect(frontend_page.locator('img[src*="/48x48.jpg"]').first).to_be_visible(timeout=30000)


@then("the selected round artwork URLs are sized for their display contexts")
def selected_round_artwork_urls_are_sized_for_their_display_contexts(socket_client):
    state = _current_backend_state(socket_client)
    assert any("/1024x1024.jpg" in (track.get("artworkRevealUrl") or "") for track in state["tracks"])
    assert any("/256x256.jpg" in (track.get("artworkInfoUrl") or "") for track in state["tracks"])
    assert any("/48x48.jpg" in (track.get("artworkChipUrl") or "") for track in state["tracks"])


@then("the selected tracks include album names")
def selected_tracks_include_album_names(socket_client):
    state = _current_backend_state(socket_client)
    assert all(track.get("albumName") for track in state["tracks"])


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
    _wait_for_backend_state(socket_client, timeout=20, phase="game", step="beforePlayback")


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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code in {200, 204}
    _wait_for_joined_count(socket_client, len(socket_client.state["players"]) + (0 if any(p["id"] == actor for p in socket_client.state["players"]) else 1))
    socket_client.sleep(1.05)


@given(parsers.parse('action buttons "{actors}" are joined'))
def action_buttons_are_joined(socket_client, actors: str):
    for actor in [value for value in actors.split(",") if value]:
        response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
        assert response.status_code in {200, 204}
        socket_client.sleep(1.05)
    expected = len([value for value in actors.split(",") if value])
    _wait_for_joined_count(socket_client, expected)


@when(parsers.parse('action button "{actor}" is pressed'))
def action_button_is_pressed(frontend_page: Page, socket_client, actor: str):
    state = socket_client.state
    expects_answer = state.get("phase") == "game" and (
        state.get("step") == "playing"
        or (state.get("quizMode") == "jacket" and state.get("step") == "beforePlayback")
    )
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    last = getattr(frontend_page, "last_action_responses", {})
    last[actor] = response.status_code
    setattr(frontend_page, "last_action_responses", last)
    if response.status_code == 200:
        if expects_answer:
            _wait_for_backend_state(socket_client, step="answering", answererId=actor)
        else:
            _wait_for_joined_player(socket_client, actor)
            socket_client.sleep(1.05)


@then(parsers.parse('the gameboard shows joined player "{actor}"'))
def gameboard_shows_joined_player(frontend_page: Page, actor: str):
    expect(_visible_gameboard_page(frontend_page).get_by_label(actor).first).to_be_visible(timeout=30000)


@when("the host starts the game")
@given("the host starts the game")
def host_starts_game(socket_client):
    socket_client.emit("console:start", {"quizMode": "intro"})
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@when("the host starts a jacket game")
@given("the host starts a jacket game")
def host_starts_jacket_game(socket_client):
    socket_client.emit("console:start", {"quizMode": "jacket"})
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@then("the console shows the game is before playback")
def console_shows_before_playback(socket_client):
    socket_client.wait_for_state(phase="game", step="beforePlayback")


@then("the gameboard shows the playing stage is ready")
def gameboard_shows_playing_ready(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("♪", exact=True).first).to_be_visible(timeout=30000)


@when(parsers.parse("the frontend sets playback seconds to {seconds:d} on the slider ring"))
def frontend_sets_playback_seconds_on_ring(frontend_page: Page, socket_client, seconds: int):
    _set_console_playback_seconds(frontend_page, socket_client, seconds)


@when("the frontend presses inside the playback seconds slider ring")
def frontend_presses_inside_playback_seconds_ring(frontend_page: Page):
    _press_playback_seconds_slider(frontend_page, 270, 0.15)


@when("the frontend swipes up inside the playback seconds slider ring on a phone viewport")
def frontend_swipes_inside_playback_seconds_ring(frontend_page: Page):
    _touch_swipe_up_on_playback_seconds_slider(frontend_page, 0, 0.1)


@when("the frontend swipes up on the playback seconds slider ring on a phone viewport")
def frontend_swipes_on_playback_seconds_ring(frontend_page: Page):
    _touch_swipe_up_on_playback_seconds_slider(frontend_page, 270, 0.38)


@then("the console page has scrolled")
def console_page_has_scrolled(frontend_page: Page):
    assert frontend_page.evaluate("window.scrollY") > getattr(frontend_page, "scroll_y_before_swipe")


@then("the console page has not scrolled")
def console_page_has_not_scrolled(frontend_page: Page):
    assert frontend_page.evaluate("window.scrollY") == getattr(frontend_page, "scroll_y_before_swipe")


@then(parsers.parse("the playback seconds slider shows {seconds} seconds"))
def playback_seconds_slider_shows(frontend_page: Page, seconds: str):
    frontend_page.wait_for_timeout(300)
    expect(_playback_seconds_slider(frontend_page)).to_have_attribute("aria-valuenow", seconds)


@when("the host plays the intro")
def host_plays_intro(frontend_page: Page, socket_client):
    _set_console_playback_seconds(frontend_page, socket_client, 10)
    track = _round_track(socket_client.state)
    if track is not None:
        setattr(frontend_page, "last_played_song_id", track["id"])
    play_button = _ready_play_button(frontend_page)
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
        socket_client.sleep(0.05)
    assert next(p for p in socket_client.state["players"] if p["id"] == actor)["score"] == score


@then("the gameboard shows revealed track information")
def gameboard_shows_revealed_track_information(frontend_page: Page):
    page = _gameboard_page(frontend_page)
    _expect_any_text(page, ["Track 1", "Track 2", "Track 3"])
    _expect_any_text(page, ["Artist 1", "Artist 2", "Artist 3"])


@then("the gameboard shows a jacket hint")
def gameboard_shows_jacket_hint(frontend_page: Page):
    expect(_visible_gameboard_page(frontend_page).get_by_label("ジャケットヒント")).to_be_visible(timeout=30000)


@then("the gameboard shows revealed album information")
def gameboard_shows_revealed_album_information(frontend_page: Page):
    page = _visible_gameboard_page(frontend_page)
    _expect_any_text(page, ["Album 1", "Album 2", "Album 3"])


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
    _wait_for_backend_state(socket_client, timeout=timeout, phase="game", step="beforePlayback")


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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
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


@then(parsers.parse('the selected tracks carry album artist "{artist}"'))
def selected_tracks_carry_album_artist(socket_client, artist: str):
    tracks = socket_client.state["tracks"]
    assert [track["albumArtist"] for track in tracks] == [artist] * len(tracks)


@then(parsers.parse("the selected album count is {count:d}"))
def selected_album_count_is(socket_client, count: int):
    assert len(socket_client.state["albums"]) == count


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


@then(parsers.parse("the jacket hint slider shows {percent:d} percent"))
def jacket_hint_slider_shows(frontend_page: Page, percent: int):
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_have_attribute("aria-valuenow", str(percent))


@then("the album information is collapsed")
def album_information_collapsed(frontend_page: Page):
    panel = frontend_page.get_by_role("region", name="アルバム情報", exact=True)
    expect(panel.get_by_role("button", name="アルバム情報を開く")).to_have_attribute("aria-expanded", "false")
    expect(panel.locator("strong")).to_have_count(0)
    expect(panel.locator("img")).to_have_count(0)


@then("the album information matches the current backend album")
def album_information_matches(frontend_page: Page, socket_client):
    state = _current_backend_state(socket_client)
    album_id = state["shuffledAlbumIds"][state["roundAlbumIndex"]]
    album = next(album for album in state["albums"] if album["id"] == album_id)
    panel = frontend_page.get_by_role("region", name="アルバム情報", exact=True)
    expect(panel.locator("strong")).to_have_text(album["name"])
    expect(panel.get_by_text(album["artist"], exact=True)).to_be_visible()
    expect(panel.locator("img")).to_have_attribute("src", album["artworkInfoUrl"])


@when("album queue requests are observed")
def observe_album_queues(frontend_page: Page):
    frontend_page.evaluate("""() => {
        const mk = MusicKit.getInstance();
        const original = mk.setQueue.bind(mk);
        window.__albumQueueRequests = [];
        mk.setQueue = (options) => {
            window.__albumQueueRequests.push(options);
            return original(options);
        };
    }""")


def _revealed_track(state):
    album_id = state["shuffledAlbumIds"][state["roundAlbumIndex"]]
    album = next(a for a in state["albums"] if a["id"] == album_id)
    return next(t for t in state["tracks"] if t["id"] == album["trackIds"][0])


def _expect_entire_album_playback(frontend_page: Page, state, queue_album_id: str):
    frontend_page.wait_for_function("""({id, selected}) => {
        const mk = MusicKit.getInstance();
        const request = window.__albumQueueRequests.at(-1);
        return request?.album === id && !request.song && !request.songs &&
            request.repeatMode === MusicKit.PlayerRepeatMode.all &&
            mk.repeatMode === MusicKit.PlayerRepeatMode.all && mk.isPlaying &&
            mk.queue.items.length === 2 && mk.queue.items.some(item => !selected.includes(item.id));
    }""", arg={"id": queue_album_id, "selected": [t["id"] for t in state["tracks"]]})


@then("MusicKit plays the entire revealed album with repeat all")
def entire_album_playback(frontend_page: Page, socket_client):
    state = _current_backend_state(socket_client)
    _expect_entire_album_playback(frontend_page, state, "album-" + _revealed_track(state)["id"])


@then("MusicKit plays the entire revealed library album with repeat all")
def entire_library_album_playback(frontend_page: Page, socket_client):
    state = _current_backend_state(socket_client)
    _expect_entire_album_playback(frontend_page, state, _library_album_id(_revealed_track(state)["id"]))


@then("album playback is stopped")
def album_playback_stopped(frontend_page: Page):
    frontend_page.wait_for_function("() => !MusicKit.getInstance().isPlaying")


def _library_album_id(track_id: str) -> str:
    return "l." + "".join(ch for ch in "album" + track_id.removeprefix("i.") if ch.isalnum())


@given("the selected tracks have library IDs")
def selected_library_ids(frontend_page: Page, socket_client):
    mock = getattr(frontend_page, "music_kit_api_mock")
    state = _current_backend_state(socket_client)
    tracks = [dict(t) for t in state["tracks"]]
    album_tracks = {}
    for track in tracks:
        catalog_id = track["id"]
        track["id"] = library_song_id(catalog_id)
        album_tracks[_library_album_id(catalog_id)] = list(mock.data.albums["album-" + catalog_id].track_ids)
    set_musickit_library_albums(frontend_page, album_tracks)
    socket_client.emit("console:select-playlists", {"selectedPlaylistIds": state["selectedPlaylistIds"], "tracks": tracks})


@then("no catalog lookup is sent for library song IDs")
def no_library_catalog_requests(frontend_page: Page):
    requests = getattr(frontend_page, "request_log", [])
    assert any("/v1/me/library/songs/i." in r["url"] and "/albums" in r["url"] for r in requests)
    assert not any("/v1/me/library/songs/i." in r["url"] and "/catalog" in r["url"] for r in requests)
    assert not any("/catalog/" in r["url"] and "/songs/i." in r["url"] for r in requests)


# Console answer card steps ------------------------------------------------


def _answer_input(frontend_page: Page):
    return frontend_page.get_by_role("combobox", name="回答", exact=True)


def _answer_suggestions(frontend_page: Page):
    return frontend_page.get_by_role("listbox", name="回答候補", exact=True).get_by_role("option")


def _suggestion_title(suggestion) -> str:
    return suggestion.locator("span span").first.inner_text()


def _round_album(state):
    round_index = state["roundAlbumIndex"]
    if round_index < 0:
        return None
    album_ids = state["shuffledAlbumIds"]
    if round_index >= len(album_ids):
        return None
    album_id = album_ids[round_index]
    return next((album for album in state["albums"] if album["id"] == album_id), None)


def _console_actor_answering(frontend_page: Page, socket_client, actor: str, quiz_mode: str):
    action_button_is_joined(socket_client, actor)
    socket_client.emit("console:start", {"quizMode": quiz_mode})
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    if quiz_mode == "intro":
        socket_client.emit("console:play")
        socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    expect(_answer_input(frontend_page)).to_be_enabled(timeout=30000)


@given(parsers.parse('the frontend console has actor "{actor}" answering in an intro game'))
def frontend_console_actor_answering_intro(frontend_page: Page, socket_client, actor: str):
    frontend_console_selected_playlist(frontend_page, socket_client, "Spec Playlist A")
    _console_actor_answering(frontend_page, socket_client, actor, "intro")


@given(parsers.parse('the frontend console has actor "{actor}" answering in an intro game with {count:d} tracks'))
def frontend_console_actor_answering_intro_with_tracks(frontend_page: Page, socket_client, actor: str, count: int):
    frontend_console_selected_long_playlist(frontend_page, socket_client, "Spec Playlist Long", count)
    _console_actor_answering(frontend_page, socket_client, actor, "intro")


@given(parsers.parse('the frontend console has actor "{actor}" answering in a jacket game'))
def frontend_console_actor_answering_jacket(frontend_page: Page, socket_client, actor: str):
    frontend_console_selected_playlist(frontend_page, socket_client, "Spec Playlist A")
    _console_actor_answering(frontend_page, socket_client, actor, "jacket")


@then("the console answer input is disabled")
def console_answer_input_disabled(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_be_disabled(timeout=30000)


@then("the console answer input is enabled")
def console_answer_input_enabled(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_be_enabled(timeout=30000)


@then("the console answer input is empty")
def console_answer_input_empty(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_have_value("", timeout=30000)


@when(parsers.parse('the frontend types "{text}" into the answer input'))
def frontend_types_into_answer_input(frontend_page: Page, text: str):
    _answer_input(frontend_page).fill(text)


@when("the frontend clears the answer input")
def frontend_clears_answer_input(frontend_page: Page):
    _answer_input(frontend_page).fill("")


@then(parsers.parse('the console answer suggestions are "{titles}"'))
def console_answer_suggestions_are(frontend_page: Page, titles: str):
    expected = sorted(value for value in titles.split(",") if value)
    suggestions = _answer_suggestions(frontend_page)
    expect(suggestions).to_have_count(len(expected), timeout=30000)
    shown = sorted(_suggestion_title(suggestions.nth(index)) for index in range(len(expected)))
    assert shown == expected, shown


@then(parsers.parse('the first console answer suggestion is "{title}"'))
def first_console_answer_suggestion_is(frontend_page: Page, title: str):
    expect(_answer_suggestions(frontend_page).first.get_by_text(title, exact=True)).to_be_visible(timeout=30000)


@then(parsers.parse("the console shows {count:d} answer suggestions"))
def console_shows_answer_suggestions(frontend_page: Page, count: int):
    expect(_answer_suggestions(frontend_page)).to_have_count(count, timeout=30000)


@then("each console answer suggestion shows artwork and artist")
def each_console_answer_suggestion_shows_artwork_and_artist(frontend_page: Page, socket_client):
    suggestions = _answer_suggestions(frontend_page)
    count = suggestions.count()
    assert count > 0
    artists = {track["artist"] for track in socket_client.state["tracks"]}
    for index in range(count):
        suggestion = suggestions.nth(index)
        expect(suggestion.locator('img[src*="/48x48.jpg"]')).to_be_visible(timeout=30000)
        assert suggestion.locator("span span").nth(1).inner_text() in artists


@then("each console answer suggestion shows artist without artwork")
def each_console_answer_suggestion_shows_artist_without_artwork(frontend_page: Page, socket_client):
    suggestions = _answer_suggestions(frontend_page)
    count = suggestions.count()
    assert count > 0
    artists = {album["artist"] for album in socket_client.state["albums"]}
    for index in range(count):
        suggestion = suggestions.nth(index)
        expect(suggestion.locator("img")).to_have_count(0)
        assert suggestion.locator("span span").nth(1).inner_text() in artists


def _choose_answer(frontend_page: Page, title: str):
    _answer_input(frontend_page).fill(title)
    _answer_suggestions(frontend_page).filter(has_text=title).first.click(timeout=10000)


@when("the frontend chooses the round track in the answer card")
def frontend_chooses_round_track(frontend_page: Page, socket_client):
    track = _round_track(socket_client.state)
    assert track is not None
    _choose_answer(frontend_page, track["title"])


@when("the frontend chooses a track other than the round track in the answer card")
def frontend_chooses_other_track(frontend_page: Page, socket_client):
    state = socket_client.state
    track = _round_track(state)
    assert track is not None
    other = next(item for item in state["tracks"] if item["id"] != track["id"])
    _choose_answer(frontend_page, other["title"])


@when("the frontend chooses the round album in the answer card")
def frontend_chooses_round_album(frontend_page: Page, socket_client):
    album = _round_album(socket_client.state)
    assert album is not None
    _choose_answer(frontend_page, album["name"])


@when("the frontend chooses an album other than the round album in the answer card")
def frontend_chooses_other_album(frontend_page: Page, socket_client):
    state = socket_client.state
    album = _round_album(state)
    assert album is not None
    other = next(item for item in state["albums"] if item["id"] != album["id"])
    _choose_answer(frontend_page, other["name"])


@when("the frontend types the round track title into the answer input")
def frontend_types_round_track_title(frontend_page: Page, socket_client):
    track = _round_track(socket_client.state)
    assert track is not None
    _answer_input(frontend_page).fill(track["title"])


@when(parsers.parse('the frontend presses "{key}" in the answer input'))
def frontend_presses_key_in_answer_input(frontend_page: Page, key: str):
    _answer_input(frontend_page).press(key)


@when(parsers.parse('the frontend presses "{key}" {count:d} times in the answer input'))
def frontend_presses_key_times_in_answer_input(frontend_page: Page, key: str, count: int):
    for _ in range(count):
        _answer_input(frontend_page).press(key)


@then(parsers.parse("the console highlights answer suggestion {position:d}"))
def console_highlights_answer_suggestion(frontend_page: Page, position: int):
    suggestion = _answer_suggestions(frontend_page).nth(position - 1)
    expect(suggestion).to_have_attribute("aria-selected", "true", timeout=30000)
    selected = _answer_suggestions(frontend_page).and_(frontend_page.locator('[aria-selected="true"]'))
    expect(selected).to_have_count(1)
    option_id = suggestion.get_attribute("id")
    assert option_id
    expect(_answer_input(frontend_page)).to_have_attribute("aria-activedescendant", option_id)


@when("the frontend answers with the highlighted suggestion by Enter")
def frontend_answers_with_highlighted_suggestion(frontend_page: Page):
    highlighted = _answer_suggestions(frontend_page).and_(frontend_page.locator('[aria-selected="true"]'))
    expect(highlighted).to_have_count(1)
    setattr(frontend_page, "highlighted_answer_title", _suggestion_title(highlighted))
    _answer_input(frontend_page).press("Enter")


@then("the backend judged the highlighted suggestion")
def backend_judged_highlighted_suggestion(frontend_page: Page, socket_client):
    title = getattr(frontend_page, "highlighted_answer_title")
    track = _round_track(socket_client.state)
    assert track is not None
    expected = "correct" if track["title"] == title else "wrong"
    _wait_for_backend_state(socket_client, phase="game", step=expected)


# Playback target steps -----------------------------------------------------


def _backend_round_track_id(socket_client, offset: int = 0) -> str:
    state = _current_backend_state(socket_client)
    return state["shuffledTrackIds"][state["roundIndex"] + offset]


@given("MusicKit playback is observed")
def observe_musickit_playback(frontend_page: Page):
    frontend_page.evaluate("""() => {
        const mk = MusicKit.getInstance();
        window.__playbackEvents = [];
        window.__playbackMark = 0;
        mk.addEventListener('playbackStateDidChange', (event) => {
            window.__playbackEvents.push({
                at: performance.now(),
                state: event.state,
                itemId: event.nowPlayingItem ? event.nowPlayingItem.id : null,
                volume: mk.volume,
            });
        });
    }""")
    manifest_log: list[dict[str, float | str]] = []
    setattr(frontend_page, "manifest_log", manifest_log)
    frontend_page.on(
        "request",
        lambda request: manifest_log.append({"at": time.time(), "url": request.url}) if request.url.endswith("/index.m3u8") else None,
    )


def _mark_advance(frontend_page: Page):
    frontend_page.evaluate("() => { window.__playbackMark = performance.now(); }")
    setattr(frontend_page, "advance_marked_at", time.time())


@then("MusicKit has loaded the backend round track")
def musickit_loaded_round_track(frontend_page: Page, socket_client):
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return !mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id; }",
        arg=_backend_round_track_id(socket_client),
    )


@then("MusicKit is playing the backend round track")
def musickit_playing_round_track(frontend_page: Page, socket_client):
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id; }",
        arg=_backend_round_track_id(socket_client),
    )


@then("MusicKit is still playing the backend round track after the track duration")
def musickit_still_playing_round_track(frontend_page: Page, socket_client):
    duration_ms = frontend_page.evaluate("() => MusicKit.getInstance().currentPlaybackDuration * 1000")
    frontend_page.wait_for_timeout(duration_ms + 200)
    # 曲末で queue の次の曲へ進まず、同じ曲を頭からループしている (ループ時の再読込は数百 ms かかる)
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id && mk.currentPlaybackTime < mk.currentPlaybackDuration / 2; }",
        arg=_backend_round_track_id(socket_client),
        timeout=5000,
    )


# 次のラウンドへ の state が届いた後に前の曲の再生命令が実行されると、mark から十分遅れて
# playing へ遷移する (旧実装は seek 待ちの後 ~500ms)。mark 直前に出した命令の event 伝播は 100ms で吸収する。
@then("MusicKit does not start the previous round track after advancing")
def musickit_no_late_previous_track_start(frontend_page: Page, socket_client):
    previous_id = _backend_round_track_id(socket_client, -1)
    frontend_page.wait_for_timeout(1500)
    events = frontend_page.evaluate("() => window.__playbackEvents.filter((event) => event.at >= window.__playbackMark + 100)")
    late = [event for event in events if event["state"] == 2 and event["itemId"] == previous_id and event["volume"] > 0]
    assert late == [], events


@then("MusicKit has queued the next backend round track")
def musickit_queued_next_track(frontend_page: Page, socket_client):
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); const next = mk.queue.items[mk.nowPlayingItemIndex + 1]; return !!next && next.id === id; }",
        arg=_backend_round_track_id(socket_client, 1),
    )


def _manifest_urls_since(frontend_page: Page, since: float) -> list[str]:
    return [str(entry["url"]) for entry in getattr(frontend_page, "manifest_log") if entry["at"] >= since]


@then("MusicKit has fetched the manifest of the next backend round track")
def musickit_fetched_next_manifest(frontend_page: Page, socket_client):
    next_id = _backend_round_track_id(socket_client, 1)
    deadline = time.time() + 10
    while time.time() < deadline:
        if any(f"/{next_id}/index.m3u8" in url for url in _manifest_urls_since(frontend_page, 0)):
            return
        socket_client.sleep(0.1)
    raise AssertionError(f"manifest for {next_id} was not fetched: {_manifest_urls_since(frontend_page, 0)}")


@then("MusicKit has not fetched the manifest of the backend round track since advancing")
def musickit_no_manifest_since_advancing(frontend_page: Page, socket_client):
    round_id = _backend_round_track_id(socket_client)
    since = getattr(frontend_page, "advance_marked_at")
    fetched = [url for url in _manifest_urls_since(frontend_page, since) if f"/{round_id}/index.m3u8" in url]
    assert fetched == [], fetched
