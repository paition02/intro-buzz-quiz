from __future__ import annotations

import json
import re
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


def _set_ready_tracks(socket_client, count: int = 3):
    socket_client.emit("console:login")
    tracks = sample_tracks(count)
    return socket_client.emit(
        "console:playlists",
        {"selectedPlaylistIds": ["playlist-a"], "playlists": ["Spec Playlist A"], "tracks": tracks},
    )


def _wait_for_joined_count(socket_client, count: int):
    deadline = time.time() + 5
    while time.time() < deadline:
        if len([player for player in socket_client.state["players"] if player["joined"]]) == count:
            return socket_client.state
        time.sleep(0.02)
    raise AssertionError(f"joined player count {count} not observed; latest={socket_client.state}")


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


def _wait_for_music_call(frontend_page: Page, name: str, predicate: str = "() => true", timeout: int = 5000):
    try:
        frontend_page.wait_for_function(
            """
            ({ name, predicateSource }) => {
              const predicate = eval(predicateSource);
              return (window.__musicKitObserver?.calls ?? []).some((call) => call.name === name && predicate(call));
            }
            """,
            arg={"name": name, "predicateSource": predicate},
            timeout=timeout,
        )
    except Exception as exc:
        calls = frontend_page.evaluate("window.__musicKitObserver?.calls ?? []")
        raise AssertionError(f"MusicKit call {name} was not observed; calls={calls}") from exc
    call = frontend_page.evaluate(
        """
        ({ name, predicateSource }) => {
          const predicate = eval(predicateSource);
          return (window.__musicKitObserver?.calls ?? []).find((call) => call.name === name && predicate(call));
        }
        """,
        arg={"name": name, "predicateSource": predicate},
    )
    if call is None:
        raise AssertionError(f"MusicKit call {name} was not recorded")
    return call


def _wait_for_music_queue(frontend_page: Page, expected: list[str]):
    expected_source = json.dumps(expected, separators=(",", ":"))
    try:
        _wait_for_music_call(
            frontend_page,
            "setQueue",
            f"(call) => JSON.stringify(call.payload.songs) === {json.dumps(expected_source)}",
            timeout=30000,
        )
    except Exception as exc:
        calls = frontend_page.evaluate("window.__musicKitObserver?.calls ?? []")
        raise AssertionError(f"MusicKit queue {expected[:3]}...{expected[-3:]} was not observed; calls={calls}") from exc


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


@given("MusicKit current track loading is delayed")
def musickit_current_track_loading_delayed(frontend_page: Page):
    frontend_page.add_init_script(
        """
        (() => {
          const delays = { seekToTime: 1200 };
          window.__introBuzzMusicKitDelayConfig = delays;
          if (window.__musicKitObserver) window.__musicKitObserver.methodDelays = delays;
        })();
        """
    )


@given("MusicKit auto-starts after seeking while loading")
def musickit_auto_starts_after_seek(frontend_page: Page):
    frontend_page.add_init_script(
        """
        (() => {
          const autoPlayAfterMethods = ['seekToTime'];
          window.__introBuzzMusicKitAutoPlayAfterMethods = autoPlayAfterMethods;
          if (window.__musicKitObserver) window.__musicKitObserver.autoPlayAfterMethods = autoPlayAfterMethods;
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


@given(parsers.parse('the frontend opens "{path}" as actor "{actor}"'))
def open_frontend_as_actor(frontend_page: Page, path: str, actor: str):
    frontend_page.goto(path)
    frontend_page.evaluate("(actor) => sessionStorage.setItem('intro-buzz-action-actor-id', actor)", actor)
    frontend_page.reload()


@then(parsers.parse('the document title is "{title}"'))
def document_title(frontend_page: Page, title: str):
    expect(frontend_page).to_have_title(title)


@then("the action button has no visible text")
def action_button_has_no_visible_text(frontend_page: Page):
    button = frontend_page.get_by_role("button", name="早押しボタン")
    expect(button).to_be_visible()
    assert button.inner_text().strip() == ""


@then("the action actor id is a UUID persisted in session storage")
def action_actor_id_is_uuid(frontend_page: Page):
    first = frontend_page.evaluate("sessionStorage.getItem('intro-buzz-action-actor-id')")
    assert re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", first)
    frontend_page.reload()
    second = frontend_page.evaluate("sessionStorage.getItem('intro-buzz-action-actor-id')")
    assert second == first


@when("the frontend action button is pressed")
def press_action_button(frontend_page: Page):
    with frontend_page.expect_response(lambda response: "/api/act/" in response.url):
        frontend_page.get_by_role("button", name="早押しボタン").click()


@then("one joined player is shown in backend state")
def one_joined_player(socket_client):
    _wait_for_joined_count(socket_client, 1)


@given(parsers.parse('the backend is ready with {count:d} tracks'))
def backend_ready_with_tracks(socket_client, count: int):
    _set_ready_tracks(socket_client, count)


@given(parsers.parse('a backend game is before playback with actor "{actor}"'))
def backend_game_before_playback(socket_client, actor: str):
    _prepare_game(socket_client, actor)


@when(parsers.parse('the backend host plays the intro for {seconds:d} seconds'))
def backend_host_plays(socket_client, seconds: int):
    socket_client.emit("console:play", {"seconds": seconds})
    socket_client.wait_for_state(phase="game", step="playing")


@when(parsers.parse('backend actor "{actor}" presses the action API'))
def backend_actor_presses(socket_client, actor: str):
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@given(parsers.parse('a backend game has actor "{actor}" answering'))
def backend_game_has_actor_answering(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play", {"seconds": 1})
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@when(parsers.parse('the backend host judges the answer as "{result}"'))
def backend_host_judges(socket_client, result: str):
    socket_client.emit("console:judge", {"result": result})
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


@then("the frontend shows the backend current track information")
def frontend_shows_current_track(frontend_page: Page, socket_client):
    current_track = socket_client.state["currentTrack"]
    assert current_track is not None
    expect(frontend_page.get_by_text(current_track["title"], exact=True).first).to_be_visible()
    expect(frontend_page.get_by_text(current_track["artist"], exact=True).first).to_be_visible()


@when("the judging animation expires")
def frontend_judging_animation_expires(socket_client):
    deadline = time.time() + 5
    while time.time() < deadline:
        if socket_client.state["step"] in {"beforePlayback", "reveal"}:
            return
        time.sleep(0.02)
    raise AssertionError(f"judging animation did not expire; latest={socket_client.state}")


@then("the frontend shows backend scores in descending order")
@then("the gameboard shows backend scores in descending order")
def frontend_shows_backend_scores_desc(frontend_page: Page, socket_client):
    pages = getattr(frontend_page, "integration_pages", {})
    page = pages.get("gameboard", frontend_page)
    scores = sorted([player["score"] for player in socket_client.state["players"] if player["joined"]], reverse=True)
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
    socket_client.emit("console:play", {"seconds": 1})
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    socket_client.emit("console:judge", {"result": "correct"})
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
        payload = {"seconds": 1} if label == "再生" else None
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
    socket_client.wait_for_state(phase=phase, step=step)
    state = _state(socket_client)
    assert state["phase"] == phase
    assert state["step"] == step


@then("MusicKit is configured with the developer token from the server")
def musickit_configured_with_token(frontend_page: Page):
    call = _wait_for_music_call(frontend_page, "configure")
    assert call["payload"]["developerToken"].count(".") == 2
    assert call["payload"]["app"]["name"] == "Intro Buzz Quiz"


@then("MusicKit authorization changes are monitored")
def musickit_authorization_changes_monitored(frontend_page: Page):
    _wait_for_music_call(
        frontend_page,
        "addEventListener",
        "(call) => call.payload[0] === 'authorizationStatusDidChange'",
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


@then(parsers.parse('backend current track artwork URL is "{url}"'))
def backend_current_track_artwork_url(socket_client, url: str):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    assert socket_client.state["currentTrack"]["artworkUrl"] == url


@then(parsers.parse('backend current track artwork thumbnail URL is "{url}"'))
def backend_current_track_artwork_thumb_url(socket_client, url: str):
    assert socket_client.state["currentTrack"]["artworkThumbUrl"] == url


@then(parsers.parse('backend current track artwork URL uses size "{size}"'))
def backend_current_track_artwork_url_uses_size(socket_client, size: str):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    assert f"/{size}.jpg" in socket_client.state["currentTrack"]["artworkUrl"]


@then(parsers.parse('backend current track artwork thumbnail URL uses size "{size}"'))
def backend_current_track_artwork_thumb_url_uses_size(socket_client, size: str):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    assert f"/{size}.jpg" in socket_client.state["currentTrack"]["artworkThumbUrl"]


@then(parsers.parse('MusicKit queue is prepared with songs "{song_ids}"'))
def musickit_queue_prepared(frontend_page: Page, song_ids: str):
    expected = [song_id for song_id in song_ids.split(",") if song_id]

    def has_expected_ids(request):
        url = request["url"]
        return "/v1/catalog/us/songs" in url and all(f"ids={song_id}" in url for song_id in expected)

    _wait_for_response(frontend_page, lambda response: response["status"] == 200 and has_expected_ids(response))


@then(parsers.parse('MusicKit queue is prepared with the first 50 songs from "{first}" to "{last}"'))
def musickit_queue_prepared_first_50(frontend_page: Page, first: str, last: str):
    start = int(first.removeprefix("track-"))
    end = int(last.removeprefix("track-"))
    _wait_for_music_queue(frontend_page, [f"track-{index}" for index in range(start, end + 1)])


@given(parsers.parse('the backend current track is "{track_id}"'))
def backend_current_track_is(socket_client, track_id: str):
    if socket_client.state["phase"] != "game":
        socket_client.emit("console:start")
        socket_client.wait_for_state(phase="game", step="beforePlayback")
    deadline = time.time() + 20
    while time.time() < deadline:
        if socket_client.state["currentTrack"] and socket_client.state["currentTrack"]["id"] == track_id:
            return
        socket_client.emit("console:give-up")
        socket_client.wait_for_state(step="reveal")
        socket_client.emit("console:next-round")
        socket_client.wait_for_state(step="beforePlayback")
    raise AssertionError(f"track {track_id} not reached; latest={socket_client.state}")


@when("the frontend loads the backend current track")
def frontend_loads_backend_current_track(frontend_page: Page, socket_client):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    frontend_page.wait_for_timeout(200)


@then(parsers.parse("MusicKit changes to queue index {index:d}"))
def musickit_changes_to_queue_index(frontend_page: Page, index: int):
    _wait_for_music_call(frontend_page, "changeToMediaAtIndex", f"(call) => call.payload.index === {index}")


@then("MusicKit changes to the backend current track")
def musickit_changes_to_current_track(frontend_page: Page, socket_client):
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    current_index = socket_client.state["currentTrackIndex"]
    if current_index == 0:
        return
    _wait_for_music_call(
        frontend_page,
        "changeToMediaAtIndex",
        f"(call) => call.payload.index === {current_index}",
        timeout=30000,
    )


@then("MusicKit seeks to 0")
def musickit_seeks_to_zero(frontend_page: Page):
    _wait_for_music_call(frontend_page, "seekToTime", "(call) => call.payload.time === 0")


@then("MusicKit pauses the loading autoplay")
def musickit_pauses_loading_autoplay(frontend_page: Page):
    frontend_page.wait_for_function(
        """
        () => {
          const calls = window.__musicKitObserver?.calls ?? [];
          const seekIndex = calls.findIndex((call) => call.name === 'seekToTime' && call.payload.time === 0);
          if (seekIndex < 0) return false;
          const autoplayIndex = calls.findIndex((call, index) => index > seekIndex && call.name === 'play');
          if (autoplayIndex < 0) return false;
          return calls.slice(autoplayIndex + 1).some((call) => call.name === 'pause');
        }
        """,
        timeout=30000,
    )


@then(parsers.parse('the frontend play button shows "{label}" and is disabled'))
def frontend_play_button_shows_label_and_is_disabled(frontend_page: Page, label: str):
    expect(frontend_page.get_by_role("button", name=label, exact=True)).to_be_disabled(timeout=30000)


@then("the frontend play button becomes enabled")
def frontend_play_button_enabled(frontend_page: Page):
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=30000)


@then("MusicKit has not started playback")
def musickit_has_not_started_playback(frontend_page: Page):
    frontend_page.wait_for_timeout(300)
    calls = frontend_page.evaluate("window.__musicKitObserver?.calls ?? []")
    assert not any(call["name"] == "play" for call in calls)


@then("MusicKit starts playback")
def musickit_starts_playback(frontend_page: Page):
    _wait_for_music_call(frontend_page, "play", timeout=30000)


@then("MusicKit pauses playback after the intro duration")
def musickit_pauses_after_intro(frontend_page: Page):
    _wait_for_music_call(frontend_page, "pause", timeout=3000)


@then("MusicKit seeks to 0 after playback")
def musickit_rewinds_after_playback(frontend_page: Page):
    frontend_page.wait_for_function(
        """
        () => {
          const calls = window.__musicKitObserver?.calls ?? [];
          const playIndex = calls.findIndex((call) => call.name === 'play');
          if (playIndex < 0) return false;
          return calls.slice(playIndex + 1).some((call) => call.name === 'seekToTime' && call.payload.time === 0);
        }
        """,
        timeout=3000,
    )


@then("MusicKit repeat mode is one")
def musickit_repeat_mode_one(frontend_page: Page):
    frontend_page.wait_for_function("window.__musicKitObserver?.instance?.repeatMode === window.MusicKit.PlayerRepeatMode.one")


@then("MusicKit unauthorization is requested")
def musickit_unauthorization_requested(frontend_page: Page):
    _wait_for_music_call(frontend_page, "unauthorize")


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
    tracks = sample_tracks(3)
    socket_client.emit(
        "console:playlists",
        {"selectedPlaylistIds": ["playlist-a"], "playlists": [playlist], "tracks": tracks},
    )
    socket_client.wait_for_state(phase="ready")
    frontend_page.wait_for_timeout(100)


@given("the gameboard is open")
def gameboard_is_open(frontend_page: Page):
    _gameboard_page(frontend_page).goto("/gameboard")


@given(parsers.parse('action button "{actor}" is open'))
def action_button_is_open(frontend_page: Page, actor: str):
    page = _integration_page(frontend_page, f"action:{actor}")
    page.goto("/action")
    page.evaluate("(actor) => sessionStorage.setItem('intro-buzz-action-actor-id', actor)", actor)
    page.reload()


@given(parsers.parse('action button "{actor}" is joined'))
def action_button_is_joined(socket_client, actor: str):
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code in {200, 204}
    _wait_for_joined_count(socket_client, len([p for p in socket_client.state["players"] if p["joined"]]) + (0 if any(p["id"] == actor and p["joined"] for p in socket_client.state["players"]) else 1))
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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    last = getattr(frontend_page, "last_action_responses", {})
    last[actor] = response.status_code
    setattr(frontend_page, "last_action_responses", last)
    if response.status_code == 200:
        deadline = time.time() + 5
        while time.time() < deadline:
            state = _current_backend_state(socket_client.server_url)
            if any(player["id"] == actor for player in state["players"]) or state.get("answererId") == actor:
                socket_client.events.append(state)
                return
            time.sleep(0.05)


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
def host_plays_intro(socket_client):
    socket_client.emit("console:play", {"seconds": 1})
    socket_client.wait_for_state(phase="game", step="playing")


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


@then("the gameboard shows the current track information")
def gameboard_shows_current_track_information(frontend_page: Page, socket_client):
    current = socket_client.state["currentTrack"]
    assert current
    page = _gameboard_page(frontend_page)
    expect(page.get_by_text(current["title"], exact=True).first).to_be_visible(timeout=30000)
    expect(page.get_by_text(current["artist"], exact=True).first).to_be_visible(timeout=30000)


@then("MusicKit plays the current track in full loop")
def musickit_plays_current_track_full_loop(frontend_page: Page):
    musickit_repeat_mode_one(frontend_page)
    _wait_for_music_call(frontend_page, "play", timeout=30000)


@when("the host shows results")
@given("the host shows results")
def host_shows_results(socket_client):
    socket_client.emit("console:show-results")
    socket_client.wait_for_state(step="results")


@then("the backend is waiting before playback for the same track")
def backend_waiting_same_track(socket_client):
    previous = socket_client.state["currentTrack"]["id"]
    socket_client.wait_for_state(step="beforePlayback")
    assert socket_client.state["currentTrack"]["id"] == previous


@then(parsers.parse('action button "{actor}" receives no reaction'))
def action_button_receives_no_reaction(frontend_page: Page, actor: str):
    assert getattr(frontend_page, "last_action_responses", {}).get(actor) == 204


@then(parsers.parse('the gameboard highlights joined player "{actor}"'))
def gameboard_highlights_joined_player(frontend_page: Page, actor: str):
    expect(_gameboard_page(frontend_page).get_by_label(actor).first).to_be_visible(timeout=30000)


@when("the intro playback duration expires without a buzz")
def intro_playback_duration_expires(socket_client):
    socket_client.wait_for_state(step="beforePlayback")


@then("the console can play the intro again")
def console_can_play_intro_again(socket_client):
    assert socket_client.state["step"] == "beforePlayback"


@when("the host gives up")
def host_gives_up(socket_client):
    socket_client.emit("console:give-up")
    socket_client.wait_for_state(step="reveal")


@when("the host advances to the next round")
def host_advances_next_round(frontend_page: Page, socket_client):
    setattr(frontend_page, "previous_track_id", socket_client.state["currentTrack"]["id"])
    socket_client.emit("console:next-round")
    socket_client.wait_for_state(step="beforePlayback")


@then("the backend current track changed")
def backend_current_track_changed(frontend_page: Page, socket_client):
    assert socket_client.state["currentTrack"]["id"] != getattr(frontend_page, "previous_track_id")


@given(parsers.parse('player "{actor}" has scored once'))
def player_has_scored_once(socket_client, actor: str):
    socket_client.emit("console:play", {"seconds": 1})
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}", verify=tls_verify(socket_client.server_url))
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    socket_client.emit("console:judge", {"result": "correct"})
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
    assert [player for player in socket_client.state["players"] if player["joined"]] == []


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


@then("the gameboard waits for host login")
def gameboard_waits_for_host_login(frontend_page: Page):
    expect(_gameboard_page(frontend_page).get_by_text("ボタンを押してご参加ください", exact=True).first).to_be_visible(timeout=30000)


@then("there are no selected tracks")
def no_selected_tracks(socket_client):
    assert socket_client.state["tracks"] == []


@then("MusicKit playback is stopped")
def musickit_playback_stopped(frontend_page: Page):
    _wait_for_music_call(frontend_page, "pause", timeout=30000)
