from __future__ import annotations

import re
import time

import httpx
from playwright.sync_api import Page, expect
from pytest_bdd import given, parsers, scenarios, then, when

from frontend.helpers import sample_tracks

scenarios("../../features/frontend")


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


def _music_calls(frontend_page: Page):
    return frontend_page.evaluate("window.__musicKitMock?.calls ?? []")


def _wait_for_music_call(frontend_page: Page, name: str, predicate: str = "() => true", timeout: int = 5000):
    frontend_page.wait_for_function(
        """
        ({ name, predicateSource }) => {
          const predicate = eval(predicateSource);
          return (window.__musicKitMock?.calls ?? []).some((call) => call.name === name && predicate(call));
        }
        """,
        arg={"name": name, "predicateSource": predicate},
        timeout=timeout,
    )
    call = frontend_page.evaluate(
        """
        ({ name, predicateSource }) => {
          const predicate = eval(predicateSource);
          return (window.__musicKitMock?.calls ?? []).find((call) => call.name === name && predicate(call));
        }
        """,
        arg={"name": name, "predicateSource": predicate},
    )
    if call is None:
        raise AssertionError(f"MusicKit call {name} was not recorded")
    return call


def _prepare_game(socket_client, actor: str = "player-front"):
    _set_ready_tracks(socket_client, 3)
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
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
    frontend_page.add_init_script("window.__musicKitMockOptions = { authorized: true };")


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
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)


@then(parsers.parse('backend answerer is "{actor}"'))
def backend_answerer_is(socket_client, actor: str):
    socket_client.wait_for_state(answererId=actor)
    assert _state(socket_client)["answererId"] == actor


@then(parsers.parse('the frontend shows "{text}"'))
def frontend_shows(frontend_page: Page, text: str):
    expect(frontend_page.get_by_text(text, exact=True).first).to_be_visible()


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


@given(parsers.parse('a backend game has results with actor "{actor}" scoring once'))
def backend_game_has_results(socket_client, actor: str):
    _prepare_game(socket_client, actor)
    socket_client.emit("console:play", {"seconds": 1})
    socket_client.wait_for_state(step="playing")
    response = httpx.post(f"{socket_client.server_url}/api/act/{actor}")
    assert response.status_code == 200
    socket_client.wait_for_state(step="answering", answererId=actor)
    socket_client.emit("console:judge", {"result": "correct"})
    socket_client.wait_for_state(step="reveal")
    socket_client.emit("console:show-results")
    socket_client.wait_for_state(step="results")


@when(parsers.parse('the frontend clicks "{label}"'))
def frontend_clicks(frontend_page: Page, label: str):
    frontend_page.get_by_role("button", name=label, exact=True).click()


@given("the frontend console is logged into mocked MusicKit")
def frontend_console_logged_in(frontend_page: Page):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="Apple Musicにログイン", exact=True).click()
    expect(frontend_page.get_by_text("Spec Playlist A", exact=True)).to_be_visible()


@when(parsers.parse('the frontend opens playlist "{playlist}"'))
def frontend_opens_playlist(frontend_page: Page, playlist: str):
    item = frontend_page.locator("li", has_text=playlist).first
    item.get_by_role("button", name="プレイリストを開く").click()


@then(parsers.parse('backend selected playlist ids are "{ids}"'))
def backend_selected_playlist_ids(socket_client, ids: str):
    expected = [value for value in ids.split(",") if value]
    socket_client.wait_for_state()
    assert _state(socket_client)["selectedPlaylistIds"] == expected


@given(parsers.parse('the frontend console selected playlist "{playlist}"'))
def frontend_console_selected_playlist(frontend_page: Page, playlist: str):
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
    assert call["payload"]["developerToken"] == "spec-token"
    assert call["payload"]["app"]["name"] == "Intro Buzz Quiz"


@then("MusicKit authorization changes are monitored")
def musickit_authorization_changes_monitored(frontend_page: Page):
    _wait_for_music_call(
        frontend_page,
        "addEventListener",
        "(call) => call.payload.name === 'authorizationStatusDidChange'",
    )


@then("MusicKit authorization is requested")
def musickit_authorization_requested(frontend_page: Page):
    _wait_for_music_call(frontend_page, "authorize")


@then("MusicKit library playlists are requested")
def musickit_library_playlists_requested(frontend_page: Page):
    _wait_for_music_call(
        frontend_page,
        "api.music",
        "(call) => call.payload.url === '/v1/me/library/playlists' && call.payload.params.limit === 100",
    )


@then(parsers.parse('MusicKit tracks for library playlist "{playlist_id}" are requested'))
def musickit_library_tracks_requested(frontend_page: Page, playlist_id: str):
    _wait_for_music_call(
        frontend_page,
        "api.music",
        f"(call) => call.payload.url === '/v1/me/library/playlists/{playlist_id}/tracks' && call.payload.params.include === 'catalog'",
    )


@then(parsers.parse('MusicKit queue is prepared with songs "{song_ids}"'))
def musickit_queue_prepared(frontend_page: Page, song_ids: str):
    expected = [song_id for song_id in song_ids.split(",") if song_id]
    _wait_for_music_call(
        frontend_page,
        "setQueue",
        f"(call) => JSON.stringify(call.payload.songs) === JSON.stringify({expected!r}) && call.payload.startPlaying === false",
    )


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
    )


@then("MusicKit seeks to 0")
def musickit_seeks_to_zero(frontend_page: Page):
    _wait_for_music_call(frontend_page, "seekToTime", "(call) => call.payload.time === 0")


@then("MusicKit starts playback")
def musickit_starts_playback(frontend_page: Page):
    _wait_for_music_call(frontend_page, "play")


@then("MusicKit pauses playback after the intro duration")
def musickit_pauses_after_intro(frontend_page: Page):
    _wait_for_music_call(frontend_page, "pause", timeout=3000)


@then("MusicKit seeks to 0 after playback")
def musickit_rewinds_after_playback(frontend_page: Page):
    frontend_page.wait_for_function(
        """
        () => {
          const calls = window.__musicKitMock?.calls ?? [];
          const playIndex = calls.findIndex((call) => call.name === 'play');
          if (playIndex < 0) return false;
          return calls.slice(playIndex + 1).some((call) => call.name === 'seekToTime' && call.payload.time === 0);
        }
        """,
        timeout=3000,
    )


@then("MusicKit repeat mode is one")
def musickit_repeat_mode_one(frontend_page: Page):
    frontend_page.wait_for_function("window.__musicKitMock?.instance?.repeatMode === window.MusicKit.PlayerRepeatMode.one")
