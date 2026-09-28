"""Console, action, gameboard, and full-session scenarios.

Every step drives the game the way a person does (console buttons, the
action page, the action API) and verifies what the console, gameboard, and
action pages show. The server's state is never read.
"""

from __future__ import annotations

import json
import math
import re
import time
from urllib.parse import unquote, urlparse

from playwright.sync_api import Page, Route, expect
from pytest_bdd import given, parsers, scenarios, then, when

from frontend.conftest import prepare_page
from frontend.helpers import (
    ALBUM_NAME,
    ARTIST_NAME,
    STAGE_TIMEOUT_MS,
    TRACK_TITLE,
    album_first_track_id,
    catalog_album_id,
    click,
    expect_answerer,
    expect_no_participants,
    expect_no_selection,
    expect_participant,
    expect_results_score,
    expect_score,
    expect_selection,
    expect_some_participant,
    expect_stage,
    expect_stage_in,
    library_album_id_for,
    play_button,
    play_intro,
    round_info_title,
    round_track_id,
)
from frontend.musickit_mock import (
    library_song_id,
    set_musickit_library_data,
    set_musickit_library_folders,
    set_musickit_library_only_playlist,
    set_musickit_library_song_albums,
)

scenarios(
    "../../features/frontend/console_page.feature",
    "../../features/frontend/action_page.feature",
    "../../features/frontend/apple_music.feature",
    "../../features/frontend/gameboard_page.feature",
    "../../features/integration/game_session.feature",
)

# The action API accepts one action per player every 250ms; a join followed by a
# buzz within the cooldown is ignored, so steps that join wait it out.
ACTION_COOLDOWN_MS = 1100

KNOWN_PLAYLISTS = ["Spec Playlist A", "Spec Playlist B"]


# Pages ----------------------------------------------------------------------
#
# ``frontend_page`` is the page a scenario opens itself. A scenario may also need
# the other surfaces of the same game: the host console, the gameboard, and the
# action pages. Those open lazily in the same browser context.


def _pages(frontend_page: Page) -> dict[str, Page]:
    pages = getattr(frontend_page, "integration_pages", None)
    if pages is None:
        pages = {}
        setattr(frontend_page, "integration_pages", pages)
    return pages


def _integration_page(frontend_page: Page, name: str) -> Page:
    pages = _pages(frontend_page)
    if name not in pages:
        pages[name] = frontend_page.context.new_page()
    return pages[name]


def _path(page: Page) -> str:
    return urlparse(page.url).path


def _console(frontend_page: Page) -> Page:
    if _path(frontend_page) == "/console":
        return frontend_page
    pages = _pages(frontend_page)
    if "console" not in pages:
        page = frontend_page.context.new_page()
        prepare_page(page)
        page.goto("/console")
        pages["console"] = page
    return pages["console"]


def _board(frontend_page: Page) -> Page:
    if _path(frontend_page) == "/gameboard":
        return frontend_page
    pages = _pages(frontend_page)
    if "gameboard" not in pages:
        page = _integration_page(frontend_page, "gameboard")
        page.goto("/gameboard")
    return pages["gameboard"]


def _log_in(console: Page):
    if console.get_by_text("Apple Music ログイン済み", exact=True).count() == 0:
        console.get_by_role("button", name="ログイン", exact=True).click(timeout=10000)
    expect(console.get_by_text("Apple Music ログイン済み", exact=True)).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    expect(console.get_by_text("Spec Playlist A", exact=True)).to_be_visible(timeout=STAGE_TIMEOUT_MS)


def _select_playlist(console: Page, playlist: str, tracks: int = 3):
    _log_in(console)
    console.get_by_role("button", name=playlist, exact=True).click(timeout=10000)
    expect_selection(console, 1, tracks)


def _join(frontend_page: Page, http, actor: str):
    response = http.post(f"/api/act/{actor}")
    assert response.status_code in {200, 204}, response.status_code
    expect_participant(_console(frontend_page), actor)
    frontend_page.wait_for_timeout(ACTION_COOLDOWN_MS)


def _start(console: Page, mode: str):
    click(console, "イントロで開始" if mode == "intro" else "ジャケットで開始")
    expect_stage(console, "ラウンド待機ステップ")
    if mode == "intro":
        expect(play_button(console)).to_be_enabled(timeout=STAGE_TIMEOUT_MS)
    else:
        expect(console.get_by_role("slider", name="ヒントレベル")).to_be_visible(timeout=STAGE_TIMEOUT_MS)


def _buzz(frontend_page: Page, http, actor: str):
    response = http.post(f"/api/act/{actor}")
    assert response.status_code == 200, response.status_code
    expect_stage(_console(frontend_page), "解答ステップ")


def _judge(console: Page, result: str):
    click(console, {"correct": "正解", "wrong": "不正解"}[result])
    expect_stage(console, {"correct": "正答ステップ", "wrong": "誤答ステップ"}[result])


def _selected_track_ids(frontend_page: Page) -> set[str]:
    """Every track the mocked library can put into the game."""
    mock = getattr(frontend_page, "music_kit_api_mock")
    return {track_id for playlist in mock.data.library_playlists.values() for track_id in playlist.track_ids}


# Slider geometry -------------------------------------------------------------


def _playback_seconds_slider(frontend_page: Page):
    slider = frontend_page.get_by_role("slider", name="再生秒数")
    expect(slider).to_be_visible(timeout=STAGE_TIMEOUT_MS)
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


def _set_console_playback_seconds_on_ring(frontend_page: Page, seconds: int):
    minimum = 0.1
    maximum = 30
    progress = (seconds - minimum) / (maximum - minimum)
    slider = _press_playback_seconds_slider(frontend_page, 20 + progress * 320, 0.38)
    expect(slider).to_have_attribute("aria-valuenow", str(seconds), timeout=STAGE_TIMEOUT_MS)


# MusicKit HTTP mock helpers --------------------------------------------------


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


# Opening pages ---------------------------------------------------------------


@when(parsers.parse('the frontend opens "{path}"'))
@given(parsers.parse('the frontend opens "{path}"'))
def open_frontend(frontend_page: Page, path: str):
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


@given("the gameboard is open")
def gameboard_is_open(frontend_page: Page):
    _board(frontend_page)


@given(parsers.parse('action button "{actor}" is open'))
def action_button_is_open(frontend_page: Page, actor: str):
    page = _integration_page(frontend_page, f"action:{actor}")
    page.goto("/action")


# MusicKit library arrangements ----------------------------------------------


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
def frontend_console_logged_in_with_paginated_tracks(frontend_page: Page, playlist: str):
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
    _log_in(frontend_page)


@given('the frontend console is logged into mocked MusicKit with playlist "Spec Playlist B" in folder "Spec Folder"')
def frontend_console_logged_in_with_playlist_folder(frontend_page: Page):
    set_musickit_library_folders(
        frontend_page,
        root_children=["playlist-a", "folder-spec"],
        folders={"folder-spec": ("Spec Folder", ["playlist-b"])},
    )
    _log_in_console(frontend_page)


@given('the frontend console is logged into mocked MusicKit with playlist "Spec Playlist B" in subfolder "Spec Sub Folder" of folder "Spec Folder"')
def frontend_console_logged_in_with_playlist_subfolder(frontend_page: Page):
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
def frontend_console_logged_in_with_empty_folder(frontend_page: Page):
    set_musickit_library_folders(
        frontend_page,
        root_children=["folder-empty", "playlist-a", "playlist-b"],
        folders={"folder-empty": ("Spec Empty Folder", [])},
    )
    _log_in_console(frontend_page)


@given('the frontend console is logged into mocked MusicKit with 101 playlists in folder "Spec Folder"')
def frontend_console_logged_in_with_paginated_folder(frontend_page: Page):
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
    expect(folder_button).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    # 親フォルダの li も子フォルダのボタンを含むので、同じ行の開閉ボタンをたどる。
    toggle = folder_button.locator("xpath=following-sibling::button")
    expect(toggle).to_have_accessible_name("フォルダを開く")
    toggle.click(timeout=10000)
    expect(toggle).to_have_accessible_name("フォルダを閉じる", timeout=STAGE_TIMEOUT_MS)


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
def frontend_console_logged_in_with_long_playlist(frontend_page: Page, playlist: str, count: int):
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
def frontend_console_selected_long_playlist(frontend_page: Page, playlist: str, count: int):
    frontend_console_logged_in_with_long_playlist(frontend_page, playlist, count)
    frontend_page.get_by_role("button", name=playlist, exact=True).click()
    expect_selection(frontend_page, 1, count)


@given(parsers.parse('the frontend console is logged into mocked MusicKit with playlist "{playlist}" on two library albums of one album'))
def frontend_console_logged_in_with_two_library_albums_of_one_album(frontend_page: Page, playlist: str):
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
def frontend_console_logged_in_with_overlapping_playlists(frontend_page: Page):
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


@given(parsers.parse('library playlist "{playlist}" holds library songs without catalog counterparts'))
def library_playlist_holds_library_songs(frontend_page: Page, playlist: str):
    assert playlist == "Spec Playlist A"
    set_musickit_library_only_playlist(frontend_page, "playlist-a")


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
def frontend_console_logged_in_with_track_loading_failure(frontend_page: Page, message: str):
    _install_playlist_track_error(frontend_page, "playlist-a", message)
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@given("the frontend console is logged into mocked MusicKit")
@given("the host console is logged into mocked MusicKit")
def frontend_console_logged_in(frontend_page: Page):
    _log_in_console(frontend_page)


@given(parsers.parse('the frontend console selected playlist "{playlist}"'))
def frontend_console_selected_playlist(frontend_page: Page, playlist: str):
    frontend_page.goto("/console")
    _select_playlist(frontend_page, playlist)


@given(parsers.parse('the host selected playlist "{playlist}"'))
@given(parsers.parse('the host selects playlist "{playlist}"'))
def host_selected_playlist(frontend_page: Page, playlist: str):
    _select_playlist(_console(frontend_page), playlist)


# Generic page assertions -----------------------------------------------------


@then(parsers.parse('the document title is "{title}"'))
def document_title(frontend_page: Page, title: str):
    expect(frontend_page).to_have_title(title)


@then(parsers.parse('the frontend shows "{text}"'))
def frontend_shows(frontend_page: Page, text: str):
    if text == "正解":
        text = "○"
    if text == "不正解":
        text = "×"
    if text == "再接続中":
        text = "再接続中…"
    expect(frontend_page.get_by_text(text, exact=True).first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.parse('the frontend does not show "{text}"'))
def frontend_does_not_show(frontend_page: Page, text: str):
    expect(frontend_page.get_by_text(text, exact=True)).to_have_count(0)


@when("the frontend socket disconnects")
def frontend_socket_disconnects(frontend_page: Page):
    frontend_page.context.set_offline(True)


@when("the frontend socket reconnects")
def frontend_socket_reconnects(frontend_page: Page):
    frontend_page.context.set_offline(False)


@when(parsers.parse('the frontend clicks "{label}"'))
def frontend_clicks(frontend_page: Page, label: str):
    button = frontend_page.get_by_role("button", name=label, exact=True)
    if label == "再生":
        expect(button).to_be_enabled(timeout=STAGE_TIMEOUT_MS)
    if label == "次のラウンドへ":
        # Playback steps compare the new round against the round being left.
        setattr(frontend_page, "previous_round_track_id", round_track_id(frontend_page))
        if hasattr(frontend_page, "manifest_log"):
            _mark_advance(frontend_page)
    button.scroll_into_view_if_needed(timeout=10000)
    button.click(timeout=10000)


@when(parsers.parse('the frontend opens playlist "{playlist}"'))
def frontend_opens_playlist(frontend_page: Page, playlist: str):
    playlist_button = frontend_page.get_by_role("button", name=playlist, exact=True)
    expect(playlist_button).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    playlist_item = frontend_page.locator("li").filter(has=playlist_button).first
    playlist_item.get_by_role("button", name="プレイリストを開く").click(timeout=10000)
    expect(playlist_item.get_by_role("button", name="プレイリストを閉じる")).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.parse('the selected playlists are "{names}"'))
def selected_playlists_are(frontend_page: Page, names: str):
    expected = [value for value in names.split(",") if value]
    expect(frontend_page.get_by_text(re.compile(rf"^{len(expected)}件のプレイリスト、\d+曲を選択中$"))).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    # A playlist inside a closed folder is not on screen; its folder shows the selection instead.
    for name in KNOWN_PLAYLISTS:
        button = frontend_page.get_by_role("button", name=name, exact=True)
        if button.count():
            expect(button).to_have_attribute("aria-pressed", "true" if name in expected else "false")


@then("no playlist is selected")
def no_playlist_selected(frontend_page: Page):
    expect_no_selection(frontend_page)
    for name in KNOWN_PLAYLISTS:
        button = frontend_page.get_by_role("button", name=name, exact=True)
        if button.count():
            expect(button).to_have_attribute("aria-pressed", "false")


@then("the console shows no selected playlists")
def console_shows_no_selected_playlists(frontend_page: Page):
    expect_no_selection(_console(frontend_page))


@then(parsers.parse('the console shows the stage "{stage}"'))
def console_shows_stage(frontend_page: Page, stage: str):
    expect_stage(_console(frontend_page), stage)


@then("the console returns to waiting after the intro duration")
def console_returns_to_waiting(frontend_page: Page):
    expect_stage(_console(frontend_page), "ラウンド待機ステップ")


@then("the console shows no participants")
def console_shows_no_participants(frontend_page: Page):
    expect_no_participants(_console(frontend_page))


@then("the host console shows a participant")
def host_console_shows_participant(frontend_page: Page):
    expect_some_participant(_console(frontend_page))


# Action page -----------------------------------------------------------------


@then("the action button has no visible text")
def action_button_has_no_visible_text(frontend_page: Page):
    button = frontend_page.get_by_role("button", name="早押しボタン")
    expect(button).to_be_visible()
    assert button.inner_text().strip() == ""


def _press_action_page_button(page: Page):
    with page.expect_response(lambda response: "/api/act/" in response.url):
        page.get_by_role("button", name="早押しボタン").click()


@then("the action page keeps the same player identity after reload")
def action_page_keeps_same_player_identity(frontend_page: Page):
    console = _console(frontend_page)
    _press_action_page_button(frontend_page)
    expect_some_participant(console)
    frontend_page.wait_for_timeout(ACTION_COOLDOWN_MS)
    frontend_page.reload()
    # The same identity toggles the same participant off again.
    _press_action_page_button(frontend_page)
    expect_no_participants(console)


@when("the frontend action button is pressed")
def press_action_button(frontend_page: Page):
    _press_action_page_button(frontend_page)
    frontend_page.wait_for_timeout(ACTION_COOLDOWN_MS)


@when(parsers.parse('the host selects playlist "{playlist}" and starts the game'))
def host_selects_playlist_and_starts(frontend_page: Page, playlist: str):
    console = _console(frontend_page)
    _select_playlist(console, playlist)
    _start(console, "intro")


# Host actions ----------------------------------------------------------------


@given(parsers.parse('action button "{actor}" is joined'))
def action_button_is_joined(frontend_page: Page, http, actor: str):
    _join(frontend_page, http, actor)


@given(parsers.parse('action buttons "{actors}" are joined'))
def action_buttons_are_joined(frontend_page: Page, http, actors: str):
    for actor in [value for value in actors.split(",") if value]:
        _join(frontend_page, http, actor)


@given(parsers.parse('the host started an intro game with actor "{actor}"'))
def host_started_intro_game(frontend_page: Page, http, actor: str):
    console = _console(frontend_page)
    _select_playlist(console, "Spec Playlist A")
    _join(frontend_page, http, actor)
    _start(console, "intro")


@given(parsers.parse('the host started an intro game with actor "{actor}" answering'))
def host_started_intro_game_answering(frontend_page: Page, http, actor: str):
    host_started_intro_game(frontend_page, http, actor)
    play_intro(_console(frontend_page), 1)
    _buzz(frontend_page, http, actor)


@given(parsers.parse('the host finished a round with actor "{actor}" scoring once'))
def host_finished_round_scoring_once(frontend_page: Page, http, actor: str):
    host_started_intro_game_answering(frontend_page, http, actor)
    console = _console(frontend_page)
    _judge(console, "correct")
    expect_stage(console, "正解発表ステップ")


@when("the host starts the game")
@given("the host starts the game")
def host_starts_game(frontend_page: Page):
    _start(_console(frontend_page), "intro")


@when("the host starts a jacket game")
@given("the host starts a jacket game")
def host_starts_jacket_game(frontend_page: Page):
    _start(_console(frontend_page), "jacket")


@when(parsers.parse("the host plays a {seconds:d} second intro"))
def host_plays_seconds(frontend_page: Page, seconds: int):
    play_intro(_console(frontend_page), seconds)


@when("the host plays the intro")
def host_plays_intro(frontend_page: Page):
    console = _console(frontend_page)
    setattr(frontend_page, "last_round_title", round_info_title(console))
    play_intro(console, 10)


@when(parsers.parse('the host judges the answer as "{result}"'))
def host_judges_answer(frontend_page: Page, result: str):
    _judge(_console(frontend_page), result)


@when("the host gives up")
def host_gives_up(frontend_page: Page):
    console = _console(frontend_page)
    click(console, "ギブアップ")
    expect_stage(console, "正解発表ステップ")


@when("the host shows results")
@given("the host shows results")
def host_shows_results(frontend_page: Page):
    console = _console(frontend_page)
    click(console, "結果発表へ")
    expect_stage(console, "結果発表ステップ")


@when("the host advances to the next round")
def host_advances_next_round(frontend_page: Page):
    console = _console(frontend_page)
    click(console, "次のラウンドへ")
    expect_stage(console, "ラウンド待機ステップ")


@when("the host starts the next game setup")
def host_starts_next_game_setup(frontend_page: Page):
    console = _console(frontend_page)
    click(console, "次のゲームへ")
    expect_stage(console, "準備フェーズ")


@when("the host resets the game")
def host_resets_game(frontend_page: Page):
    console = _console(frontend_page)
    click(console, "リセット")
    # A logged-in console readies itself again right after the reset.
    expect_stage_in(console, ["初期化フェーズ", "準備フェーズ"])


@given(parsers.parse('player "{actor}" has scored once'))
def player_has_scored_once(frontend_page: Page, http, actor: str):
    console = _console(frontend_page)
    play_intro(console, 1)
    _buzz(frontend_page, http, actor)
    _judge(console, "correct")
    expect_stage(console, "正解発表ステップ")


@when(parsers.parse('action button "{actor}" is pressed'))
def action_button_is_pressed(frontend_page: Page, http, actor: str):
    response = http.post(f"/api/act/{actor}")
    last = getattr(frontend_page, "last_action_responses", {})
    last[actor] = response.status_code
    setattr(frontend_page, "last_action_responses", last)
    if response.status_code == 200:
        frontend_page.wait_for_timeout(ACTION_COOLDOWN_MS)


@then(parsers.parse('action button "{actor}" receives no reaction'))
def action_button_receives_no_reaction(frontend_page: Page, actor: str):
    assert getattr(frontend_page, "last_action_responses", {}).get(actor) == 204


@when("the intro playback duration expires without a buzz")
def intro_playback_duration_expires(frontend_page: Page):
    expect_stage(_console(frontend_page), "ラウンド待機ステップ")


@then("the console shows the same track waiting before playback")
def console_same_track_waiting(frontend_page: Page):
    console = _console(frontend_page)
    expect_stage(console, "ラウンド待機ステップ")
    assert round_info_title(console) == getattr(frontend_page, "last_round_title")


@then("the console can play the intro again")
def console_can_play_intro_again(frontend_page: Page):
    expect(play_button(_console(frontend_page))).to_be_enabled(timeout=STAGE_TIMEOUT_MS)


# Gameboard -------------------------------------------------------------------


@then(parsers.parse('the gameboard shows joined player "{actor}"'))
def gameboard_shows_joined_player(frontend_page: Page, actor: str):
    expect_participant(_board(frontend_page), actor)


@then(parsers.parse('the frontend highlights player "{actor}"'))
def frontend_highlights_player(frontend_page: Page, actor: str):
    expect_participant(frontend_page, actor)


@then("the gameboard shows the playing stage is ready")
@then("the gameboard shows the intro is playing")
def gameboard_shows_music_symbol(frontend_page: Page):
    expect(_board(frontend_page).get_by_text("♪", exact=True).first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then("the gameboard asks for an answer")
def gameboard_asks_for_answer(frontend_page: Page):
    expect(_board(frontend_page).get_by_role("heading", name="解答をどうぞ！", exact=True)).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.parse('the gameboard shows "{actor}" answering'))
def gameboard_shows_answering(frontend_page: Page, actor: str):
    expect_answerer(_board(frontend_page), actor)


@then(parsers.parse('the gameboard shows "{text}"'))
def gameboard_shows_text(frontend_page: Page, text: str):
    if text == "正解":
        text = "○"
    if text == "不正解":
        text = "×"
    expect(_board(frontend_page).get_by_text(text, exact=True).first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.re(r'the gameboard shows player "(?P<actor>[^"]+)" with (?P<score>\d+) points?'))
def gameboard_shows_player_score(frontend_page: Page, actor: str, score: str):
    expect_score(_board(frontend_page), actor, int(score))


@then(parsers.re(r'the gameboard results show player "(?P<actor>[^"]+)" with (?P<score>\d+) points?'))
def gameboard_results_show_player_score(frontend_page: Page, actor: str, score: str):
    expect_results_score(_board(frontend_page), actor, int(score))


@then("the console plays a result sound")
def console_plays_result_sound(frontend_page: Page):
    _console(frontend_page).wait_for_function(
        """
        () => {
          return (window.__introBuzzAudioEvents ?? []).some((event) => event.type === 'oscillator.start');
        }
        """,
        timeout=STAGE_TIMEOUT_MS,
    )


@then("the frontend shows revealed track information")
def frontend_shows_revealed_track(frontend_page: Page):
    _expect_any_text(frontend_page, ["Track 1", "Track 2", "Track 3"])
    _expect_any_text(frontend_page, ["Artist 1", "Artist 2", "Artist 3"])


@then("the gameboard shows revealed track information")
def gameboard_shows_revealed_track_information(frontend_page: Page):
    page = _board(frontend_page)
    _expect_any_text(page, ["Track 1", "Track 2", "Track 3"])
    _expect_any_text(page, ["Artist 1", "Artist 2", "Artist 3"])


@then("the gameboard shows a jacket hint")
def gameboard_shows_jacket_hint(frontend_page: Page):
    expect(_board(frontend_page).get_by_label("ジャケットヒント")).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then("the gameboard shows revealed album information")
def gameboard_shows_revealed_album_information(frontend_page: Page):
    _expect_any_text(_board(frontend_page), ["Album 1", "Album 2", "Album 3"])


@then("the gameboard shows the participation prompt")
def gameboard_shows_participation_prompt(frontend_page: Page):
    expect(_board(frontend_page).get_by_text("ボタンを押してご参加ください", exact=True).first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then("the gameboard shows large revealed artwork")
def gameboard_shows_large_artwork(frontend_page: Page):
    expect(_board(frontend_page).locator('img[src*="/1024x1024.jpg"]').first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


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


@then("the gameboard fullscreen button is hidden")
def gameboard_fullscreen_button_hidden(frontend_page: Page):
    expect(_fullscreen_button(frontend_page)).to_have_count(1, timeout=STAGE_TIMEOUT_MS)
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
        timeout=STAGE_TIMEOUT_MS,
    ).json_value()
    assert request["tagName"] == "MAIN"
    assert request["navigationUI"] == "hide"
    assert "gameboard-screen" in request["className"]


@then("the gameboard fullscreen button hides after the pointer stops")
def gameboard_fullscreen_button_hides_after_pointer_stops(frontend_page: Page):
    _wait_for_fullscreen_button_style(frontend_page, opacity="0", pointer_events="none", timeout=5000)


# Console round information ---------------------------------------------------


def _track_info(frontend_page: Page):
    return frontend_page.get_by_role("region", name="曲情報", exact=True)


@then("the console round track information is hidden")
def console_round_track_information_hidden(frontend_page: Page):
    track_info = _track_info(frontend_page)
    expect(track_info.get_by_role("button", name="曲情報を開く")).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    expect(track_info.get_by_text(TRACK_TITLE)).to_have_count(0)
    expect(track_info.get_by_text(ARTIST_NAME)).to_have_count(0)


@then("the console round track information is visible")
def console_round_track_information_visible(frontend_page: Page):
    track_info = _track_info(frontend_page)
    expect(track_info.get_by_text(TRACK_TITLE)).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    expect(track_info.get_by_text(ARTIST_NAME)).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then("the console round track information shows medium artwork")
def console_round_track_information_shows_medium_artwork(frontend_page: Page):
    expect(_track_info(frontend_page).locator('img[src*="/256x256.jpg"]')).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then("the frontend shows track chip artwork")
def frontend_shows_track_chip_artwork(frontend_page: Page):
    expect(frontend_page.locator('img[src*="/48x48.jpg"]').first).to_be_visible(timeout=STAGE_TIMEOUT_MS)


def _album_info(frontend_page: Page):
    return frontend_page.get_by_role("region", name="アルバム情報", exact=True)


@then("the album information is collapsed")
def album_information_collapsed(frontend_page: Page):
    panel = _album_info(frontend_page)
    expect(panel.get_by_role("button", name="アルバム情報を開く")).to_have_attribute("aria-expanded", "false")
    expect(panel.locator("strong")).to_have_count(0)
    expect(panel.locator("img")).to_have_count(0)


def _expect_album_information(frontend_page: Page) -> str:
    panel = _album_info(frontend_page)
    expect(panel.locator("strong")).to_have_text(ALBUM_NAME, timeout=STAGE_TIMEOUT_MS)
    expect(panel.locator("img")).to_have_attribute("src", re.compile(r"/256x256\.jpg$"))
    return panel.locator("strong").inner_text()


@then("the album information shows an album with artwork")
def album_information_shows_album(frontend_page: Page):
    setattr(frontend_page, "album_information_name", _expect_album_information(frontend_page))


@then("the album information shows a different album with artwork")
def album_information_shows_different_album(frontend_page: Page):
    name = _expect_album_information(frontend_page)
    assert name != getattr(frontend_page, "album_information_name"), name


@then(parsers.parse('the console album information shows "{name}"'))
def console_album_information_shows(frontend_page: Page, name: str):
    expect(_album_info(frontend_page).locator("strong")).to_have_text(name, timeout=STAGE_TIMEOUT_MS)


@then("the console has no further round")
def console_has_no_further_round(frontend_page: Page):
    expect(frontend_page.get_by_role("button", name="次のラウンドへ", exact=True)).to_be_disabled(timeout=STAGE_TIMEOUT_MS)


# Jacket controls -------------------------------------------------------------


@when(parsers.parse('the frontend selects jacket mode "{jacket_mode}"'))
def frontend_selects_jacket_mode(frontend_page: Page, jacket_mode: str):
    select = frontend_page.get_by_role("combobox", name="隠し方")
    select.select_option(jacket_mode)
    expect(select).to_have_value(jacket_mode, timeout=STAGE_TIMEOUT_MS)


@when("the frontend toggles jacket grayscale")
def frontend_toggles_jacket_grayscale(frontend_page: Page):
    checkbox = frontend_page.get_by_role("checkbox", name="白黒")
    expect(checkbox).to_be_checked()
    checkbox.click()
    expect(checkbox).not_to_be_checked(timeout=STAGE_TIMEOUT_MS)


@when(parsers.parse("the frontend sets jacket hint percent to {percent:d}"))
def frontend_sets_jacket_hint_percent(frontend_page: Page, percent: int):
    slider = frontend_page.get_by_role("slider", name="ヒントレベル")
    expect(slider).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    slider.focus()
    current = int(slider.get_attribute("aria-valuenow") or "1")
    key = "ArrowRight" if percent > current else "ArrowLeft"
    for _ in range(abs(percent - current)):
        frontend_page.keyboard.press(key)
        # Let server echoes interleave with the next key, exposing stale-value races.
        frontend_page.wait_for_timeout(5)
    expect(slider).to_have_attribute("aria-valuenow", str(percent), timeout=STAGE_TIMEOUT_MS)


@then("the frontend shows jacket controls")
def frontend_shows_jacket_controls(frontend_page: Page):
    expect(frontend_page.get_by_role("combobox", name="隠し方")).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    expect(frontend_page.get_by_role("checkbox", name="白黒")).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.parse('the jacket controls show mode "{jacket_mode}", grayscale off, and {percent:d} percent'))
def jacket_controls_show(frontend_page: Page, jacket_mode: str, percent: int):
    expect(frontend_page.get_by_role("combobox", name="隠し方")).to_have_value(jacket_mode)
    expect(frontend_page.get_by_role("checkbox", name="白黒")).not_to_be_checked()
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_have_attribute("aria-valuenow", str(percent))


@then(parsers.parse("the jacket hint slider shows {percent:d} percent"))
def jacket_hint_slider_shows(frontend_page: Page, percent: int):
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_have_attribute("aria-valuenow", str(percent))


# MusicKit requests -----------------------------------------------------------


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


@then("no catalog lookup is sent for library song IDs")
def no_library_catalog_requests(frontend_page: Page):
    requests = getattr(frontend_page, "request_log", [])
    assert any("/v1/me/library/songs/i." in r["url"] and "/albums" in r["url"] for r in requests)
    assert not any("/v1/me/library/songs/i." in r["url"] and "/catalog" in r["url"] for r in requests)
    assert not any("/catalog/" in r["url"] and "/songs/i." in r["url"] for r in requests)


# Playback controls -----------------------------------------------------------


@then(parsers.parse('the frontend play button shows "{label}" and is disabled'))
def frontend_play_button_shows_label_and_is_disabled(frontend_page: Page, label: str):
    expect(frontend_page.get_by_role("button", name=label, exact=True)).to_be_disabled(timeout=STAGE_TIMEOUT_MS)


@then("the frontend play button becomes enabled")
def frontend_play_button_enabled(frontend_page: Page):
    expect(play_button(frontend_page)).to_be_enabled(timeout=STAGE_TIMEOUT_MS)


@when(parsers.parse("the frontend sets playback seconds to {seconds:d} on the slider ring"))
def frontend_sets_playback_seconds_on_ring(frontend_page: Page, seconds: int):
    _set_console_playback_seconds_on_ring(frontend_page, seconds)


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


# Jacket album playback -------------------------------------------------------


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


def _expect_entire_album_playback(frontend_page: Page, queue_album_id: str):
    frontend_page.wait_for_function("""({id, selected}) => {
        const mk = MusicKit.getInstance();
        const request = window.__albumQueueRequests.at(-1);
        return request?.album === id && !request.song && !request.songs &&
            request.repeatMode === MusicKit.PlayerRepeatMode.all &&
            mk.repeatMode === MusicKit.PlayerRepeatMode.all && mk.isPlaying &&
            mk.queue.items.length === 2 && mk.queue.items.some(item => !selected.includes(item.id));
    }""", arg={"id": queue_album_id, "selected": sorted(_selected_track_ids(frontend_page))})


@then("MusicKit plays the entire revealed album with repeat all")
def entire_album_playback(frontend_page: Page):
    expect_stage(frontend_page, "正解発表ステップ")
    _expect_entire_album_playback(frontend_page, catalog_album_id(round_info_title(frontend_page)))


@then("MusicKit plays the entire revealed library album with repeat all")
def entire_library_album_playback(frontend_page: Page):
    expect_stage(frontend_page, "正解発表ステップ")
    first_track = library_song_id(album_first_track_id(round_info_title(frontend_page)))
    _expect_entire_album_playback(frontend_page, library_album_id_for(first_track))


@then("album playback is stopped")
def album_playback_stopped(frontend_page: Page):
    frontend_page.wait_for_function("() => !MusicKit.getInstance().isPlaying")


# Console answer card ---------------------------------------------------------


def _answer_input(frontend_page: Page):
    return frontend_page.get_by_role("combobox", name="回答", exact=True)


def _answer_suggestions(frontend_page: Page):
    return frontend_page.get_by_role("listbox", name="回答候補", exact=True).get_by_role("option")


def _suggestion_title(suggestion) -> str:
    return suggestion.locator("span span").first.inner_text()


def _console_actor_answering(frontend_page: Page, http, actor: str, quiz_mode: str):
    _join(frontend_page, http, actor)
    _start(frontend_page, quiz_mode)
    if quiz_mode == "intro":
        play_intro(frontend_page, 1)
    _buzz(frontend_page, http, actor)
    expect(_answer_input(frontend_page)).to_be_enabled(timeout=STAGE_TIMEOUT_MS)


@given(parsers.parse('the frontend console has actor "{actor}" answering in an intro game'))
def frontend_console_actor_answering_intro(frontend_page: Page, http, actor: str):
    frontend_console_selected_playlist(frontend_page, "Spec Playlist A")
    _console_actor_answering(frontend_page, http, actor, "intro")


@given(parsers.parse('the frontend console has actor "{actor}" answering in an intro game with {count:d} tracks'))
def frontend_console_actor_answering_intro_with_tracks(frontend_page: Page, http, actor: str, count: int):
    frontend_console_selected_long_playlist(frontend_page, "Spec Playlist Long", count)
    _console_actor_answering(frontend_page, http, actor, "intro")


@given(parsers.parse('the frontend console has actor "{actor}" answering in a jacket game'))
def frontend_console_actor_answering_jacket(frontend_page: Page, http, actor: str):
    frontend_console_selected_playlist(frontend_page, "Spec Playlist A")
    _console_actor_answering(frontend_page, http, actor, "jacket")


@then("the console answer input is disabled")
def console_answer_input_disabled(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_be_disabled(timeout=STAGE_TIMEOUT_MS)


@then("the console answer input is enabled")
def console_answer_input_enabled(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_be_enabled(timeout=STAGE_TIMEOUT_MS)


@then("the console answer input is empty")
def console_answer_input_empty(frontend_page: Page):
    expect(_answer_input(frontend_page)).to_have_value("", timeout=STAGE_TIMEOUT_MS)


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
    expect(suggestions).to_have_count(len(expected), timeout=STAGE_TIMEOUT_MS)
    shown = sorted(_suggestion_title(suggestions.nth(index)) for index in range(len(expected)))
    assert shown == expected, shown


@then(parsers.parse('the first console answer suggestion is "{title}"'))
def first_console_answer_suggestion_is(frontend_page: Page, title: str):
    expect(_answer_suggestions(frontend_page).first.get_by_text(title, exact=True)).to_be_visible(timeout=STAGE_TIMEOUT_MS)


@then(parsers.parse("the console shows {count:d} answer suggestions"))
def console_shows_answer_suggestions(frontend_page: Page, count: int):
    expect(_answer_suggestions(frontend_page)).to_have_count(count, timeout=STAGE_TIMEOUT_MS)


@then("each console answer suggestion shows artwork and artist")
def each_console_answer_suggestion_shows_artwork_and_artist(frontend_page: Page):
    suggestions = _answer_suggestions(frontend_page)
    count = suggestions.count()
    assert count > 0
    for index in range(count):
        suggestion = suggestions.nth(index)
        expect(suggestion.locator('img[src*="/48x48.jpg"]')).to_be_visible(timeout=STAGE_TIMEOUT_MS)
        number = _suggestion_title(suggestion).removeprefix("Track ")
        expect(suggestion.locator("span span").nth(1)).to_have_text(f"Artist {number}")


@then("each console answer suggestion shows only the album name")
def each_console_answer_suggestion_shows_only_album_name(frontend_page: Page):
    suggestions = _answer_suggestions(frontend_page)
    count = suggestions.count()
    assert count > 0
    for index in range(count):
        suggestion = suggestions.nth(index)
        expect(suggestion.locator("img")).to_have_count(0)
        expect(suggestion.locator("span span")).to_have_count(1)


def _choose_answer(frontend_page: Page, title: str):
    _answer_input(frontend_page).fill(title)
    _answer_suggestions(frontend_page).filter(has_text=title).first.click(timeout=10000)


def _choose_other_answer(frontend_page: Page, query: str, round_title: str):
    _answer_input(frontend_page).fill(query)
    other = _answer_suggestions(frontend_page).filter(has_not_text=round_title).first
    expect(other).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    other.click(timeout=10000)


@when("the frontend chooses the round track in the answer card")
@when("the frontend chooses the round album in the answer card")
def frontend_chooses_round_answer(frontend_page: Page):
    _choose_answer(frontend_page, round_info_title(frontend_page))


@when("the frontend chooses a track other than the round track in the answer card")
def frontend_chooses_other_track(frontend_page: Page):
    _choose_other_answer(frontend_page, "Track", round_info_title(frontend_page))


@when("the frontend chooses an album other than the round album in the answer card")
def frontend_chooses_other_album(frontend_page: Page):
    _choose_other_answer(frontend_page, "Album", round_info_title(frontend_page))


@when("the frontend types the round track title into the answer input")
def frontend_types_round_track_title(frontend_page: Page):
    _answer_input(frontend_page).fill(round_info_title(frontend_page))


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
    expect(suggestion).to_have_attribute("aria-selected", "true", timeout=STAGE_TIMEOUT_MS)
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
    setattr(frontend_page, "round_title_before_answer", round_info_title(frontend_page))
    _answer_input(frontend_page).press("Enter")


@then("the console shows the judgment of the highlighted suggestion")
def console_shows_judgment_of_highlighted_suggestion(frontend_page: Page):
    title = getattr(frontend_page, "highlighted_answer_title")
    round_title = getattr(frontend_page, "round_title_before_answer")
    expect_stage(frontend_page, "正答ステップ" if round_title == title else "誤答ステップ")


# Playback target steps -------------------------------------------------------


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


@then("MusicKit has loaded the round track")
def musickit_loaded_round_track(frontend_page: Page):
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return !mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id; }",
        arg=round_track_id(frontend_page),
    )


@then("MusicKit is playing the round track")
def musickit_playing_round_track(frontend_page: Page):
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id; }",
        arg=round_track_id(frontend_page),
    )


@then("MusicKit is still playing the round track after the track duration")
def musickit_still_playing_round_track(frontend_page: Page):
    duration_ms = frontend_page.evaluate("() => MusicKit.getInstance().currentPlaybackDuration * 1000")
    frontend_page.wait_for_timeout(duration_ms + 200)
    # 曲末で queue の次の曲へ進まず、同じ曲を頭からループしている (ループ時の再読込は数百 ms かかる)
    frontend_page.wait_for_function(
        "(id) => { const mk = MusicKit.getInstance(); return mk.isPlaying && mk.nowPlayingItem && mk.nowPlayingItem.id === id && mk.currentPlaybackTime < mk.currentPlaybackDuration / 2; }",
        arg=round_track_id(frontend_page),
        timeout=5000,
    )


# 次のラウンドへ の state が届いた後に前の曲の再生命令が実行されると、mark から十分遅れて
# playing へ遷移する (旧実装は seek 待ちの後 ~500ms)。mark 直前に出した命令の event 伝播は 100ms で吸収する。
@then("MusicKit does not start the previous round track after advancing")
def musickit_no_late_previous_track_start(frontend_page: Page):
    previous_id = getattr(frontend_page, "previous_round_track_id")
    frontend_page.wait_for_timeout(1500)
    events = frontend_page.evaluate("() => window.__playbackEvents.filter((event) => event.at >= window.__playbackMark + 100)")
    late = [event for event in events if event["state"] == 2 and event["itemId"] == previous_id and event["volume"] > 0]
    assert late == [], events


@then("MusicKit has queued another selected track next")
def musickit_queued_another_track(frontend_page: Page):
    current_id = round_track_id(frontend_page)
    selected = _selected_track_ids(frontend_page)
    next_id = frontend_page.wait_for_function(
        "() => { const mk = MusicKit.getInstance(); const next = mk.queue.items[mk.nowPlayingItemIndex + 1]; return next ? next.id : null; }",
    ).json_value()
    assert next_id in selected and next_id != current_id, (next_id, current_id)
    setattr(frontend_page, "queued_next_track_id", next_id)


def _manifest_urls_since(frontend_page: Page, since: float) -> list[str]:
    return [str(entry["url"]) for entry in getattr(frontend_page, "manifest_log") if entry["at"] >= since]


@then("MusicKit has fetched the manifest of the queued next track")
def musickit_fetched_next_manifest(frontend_page: Page):
    next_id = getattr(frontend_page, "queued_next_track_id")
    deadline = time.time() + 10
    while time.time() < deadline:
        if any(f"/{next_id}/index.m3u8" in url for url in _manifest_urls_since(frontend_page, 0)):
            return
        frontend_page.wait_for_timeout(100)
    raise AssertionError(f"manifest for {next_id} was not fetched: {_manifest_urls_since(frontend_page, 0)}")


@then("the round track is the previously queued next track")
def round_track_is_queued_next(frontend_page: Page):
    assert round_track_id(frontend_page) == getattr(frontend_page, "queued_next_track_id")


@then("MusicKit has not fetched the manifest of the round track since advancing")
def musickit_no_manifest_since_advancing(frontend_page: Page):
    round_id = round_track_id(frontend_page)
    since = getattr(frontend_page, "advance_marked_at")
    fetched = [url for url in _manifest_urls_since(frontend_page, since) if f"/{round_id}/index.m3u8" in url]
    assert fetched == [], fetched
