from __future__ import annotations

import time
from typing import Any

from pytest_bdd import given, parsers, scenarios, then, when

from backend.helpers import assert_player, make_tracks

scenarios("../../features/backend")


def _reset(socket_client):
    state = socket_client.emit("console:reset")
    socket_client.wait_for_state(phase="initialization", step="idle")
    return state


def _login(socket_client):
    state = socket_client.emit("console:login")
    socket_client.wait_for_state(phase="ready")
    return state


def _select_tracks(socket_client, count: int = 3):
    tracks = make_tracks(count)
    state = socket_client.emit(
        "console:playlists",
        {"playlists": ["Playlist A"], "selectedPlaylistIds": ["playlist-a"], "tracks": tracks},
    )
    return state, tracks


def _join_actor(http, actor_id: str):
    response = http.post(f"/api/act/{actor_id}")
    assert response.status_code == 200
    time.sleep(0.28)
    return response


def _start_game(socket_client, http, joined: list[str] | None = None, count: int = 3):
    _login(socket_client)
    for actor_id in joined or []:
        _join_actor(http, actor_id)
    state, tracks = _select_tracks(socket_client, count)
    state = socket_client.emit("console:start")
    socket_client.wait_for_state(phase="game", step="beforePlayback")
    return state, tracks


def _latest(socket_client, ctx):
    ctx.state = socket_client.state
    return ctx.state


@given("a fresh server state")
def fresh_server_state(ctx, socket_client):
    ctx.state = _reset(socket_client)


@given("the host is logged in")
def host_logged_in(ctx, socket_client):
    _reset(socket_client)
    ctx.state = _login(socket_client)


@given(parsers.parse('players "{actor_ids}" are joined'))
def players_joined(ctx, http, socket_client, actor_ids: str):
    for actor_id in [item.strip() for item in actor_ids.split(",") if item.strip()]:
        _join_actor(http, actor_id)
    ctx.state = socket_client.state


@given(parsers.parse("the host has selected {count:d} tracks"))
def host_selected_tracks(ctx, socket_client, count: int):
    ctx.state, ctx.tracks = _select_tracks(socket_client, count)


@given(parsers.parse('a game is before playback with joined players "{actor_ids}"'))
def game_before_playback(ctx, socket_client, http, actor_ids: str):
    joined = [item.strip() for item in actor_ids.split(",") if item.strip()]
    ctx.state, ctx.tracks = _start_game(socket_client, http, joined=joined, count=3)


@given(parsers.parse('player "{actor_id}" has answer rights'))
def player_has_answer_rights(ctx, socket_client, http, actor_id: str):
    ctx.state, ctx.tracks = _start_game(socket_client, http, joined=[actor_id], count=3)
    socket_client.emit("console:play", {"seconds": 1})
    response = http.post(f"/api/act/{actor_id}")
    assert response.status_code == 200
    ctx.response = response
    ctx.actor_id = actor_id
    socket_client.wait_for_state(step="answering")
    ctx.state = socket_client.state


@given("the game is revealing the answer")
def game_revealing(ctx, socket_client, http):
    ctx.state, ctx.tracks = _start_game(socket_client, http, joined=["player-1"], count=3)
    ctx.state = socket_client.emit("console:give-up")
    socket_client.wait_for_state(step="reveal")


@given(parsers.parse("a started game with {count:d} tracks"))
def started_game_with_tracks(ctx, socket_client, http, count: int):
    ctx.state, ctx.tracks = _start_game(socket_client, http, joined=["player-1"], count=count)


@given(parsers.parse('the game is showing results with players "{actor_ids}"'))
def game_showing_results(ctx, socket_client, http, actor_ids: str):
    joined = [item.strip() for item in actor_ids.split(",") if item.strip()]
    ctx.state, ctx.tracks = _start_game(socket_client, http, joined=joined, count=3)
    socket_client.emit("console:give-up")
    socket_client.wait_for_state(step="reveal")
    ctx.state = socket_client.emit("console:show-results")
    socket_client.wait_for_state(step="results")


@when("the host logs in")
def when_host_logs_in(ctx, socket_client):
    ctx.state = socket_client.emit("console:login")


@when("the host selects playlists:")
def when_host_selects_playlists(ctx, socket_client, datatable):
    tracks: list[dict[str, Any]] = []
    playlist_names: list[str] = []
    playlist_ids: list[str] = []
    offset = 1
    for row in datatable[1:]:
        playlist_id, playlist_name, track_count = row
        playlist_ids.append(playlist_id)
        playlist_names.append(playlist_name)
        new_tracks = make_tracks(int(track_count), playlist=playlist_name, offset=offset)
        tracks.extend(new_tracks)
        offset += int(track_count)
    ctx.tracks = tracks
    ctx.state = socket_client.emit(
        "console:playlists",
        {"playlists": playlist_names, "selectedPlaylistIds": playlist_ids, "tracks": tracks},
    )



@when("the host sends tracks with missing id or title")
def when_host_sends_invalid_tracks(ctx, socket_client):
    tracks = [
        {"id": "valid", "title": "Valid Song", "artist": "Artist", "playlist": "Playlist A"},
        {"id": "", "title": "No ID", "artist": "Artist", "playlist": "Playlist A"},
        {"id": "no-title", "title": "", "artist": "Artist", "playlist": "Playlist A"},
    ]
    ctx.state = socket_client.emit(
        "console:playlists",
        {"playlists": ["Playlist A"], "selectedPlaylistIds": ["playlist-a"], "tracks": tracks},
    )


@when(parsers.parse("the host sets playback seconds to {seconds:g}"))
def when_host_sets_seconds(ctx, socket_client, seconds: float):
    ctx.state = socket_client.emit("console:playback-seconds", {"seconds": seconds})


@when("the host starts the game")
def when_host_starts_game(ctx, socket_client):
    ctx.state = socket_client.emit("console:start")


@when("the host resets the game")
def when_host_resets(ctx, socket_client):
    ctx.state = socket_client.emit("console:reset")


@when(parsers.parse('actor "{actor_id}" presses the action API'))
def when_actor_presses(ctx, http, socket_client, actor_id: str):
    ctx.actor_id = actor_id.strip()
    ctx.response = http.post(f"/api/act/{actor_id}")
    if ctx.response.status_code != 400:
        time.sleep(0.02)
        _latest(socket_client, ctx)


@when(parsers.parse('actor "{actor_id}" waits for cooldown'))
def wait_for_actor_cooldown(actor_id: str):
    _ = actor_id
    time.sleep(0.28)


@when("the client requests the MusicKit token")
def request_token(ctx, http):
    ctx.response = http.get("/api/token")


@when(parsers.parse('the client requests route "{route}"'))
def request_route(ctx, http, route: str):
    ctx.response = http.get(route)


@when(parsers.parse("the host plays the intro for {seconds:g} seconds"))
def host_plays_intro(ctx, socket_client, seconds: float):
    ctx.state = socket_client.emit("console:play", {"seconds": seconds})
    socket_client.wait_for_state(step="playing")


@when("the playback timeout expires")
def playback_timeout_expires(ctx, socket_client):
    deadline = time.time() + 5
    while time.time() < deadline:
        state = socket_client.state
        if state["step"] == "beforePlayback":
            ctx.state = state
            return
        time.sleep(0.03)
    raise AssertionError(f"playback timeout did not expire; latest={socket_client.state}")


@when(parsers.parse('the host judges the answer as "{result}"'))
def host_judges(ctx, socket_client, result: str):
    ctx.state = socket_client.emit("console:judge", {"result": result})


@when("the judging animation expires")
def judging_animation_expires(ctx, socket_client):
    deadline = time.time() + 5
    while time.time() < deadline:
        state = socket_client.state
        if state["step"] in {"reveal", "beforePlayback"}:
            ctx.state = state
            return
        time.sleep(0.03)
    raise AssertionError(f"judging animation did not expire; latest={socket_client.state}")


@when("the host gives up")
def host_gives_up(ctx, socket_client):
    ctx.state = socket_client.emit("console:give-up")


@when("the host shows results")
def host_shows_results(ctx, socket_client):
    ctx.state = socket_client.emit("console:show-results")


@when("the host advances to the next round")
def host_advances_next_round(ctx, socket_client):
    ctx.extra["previous_order_index"] = socket_client.state["currentGameTrackOrderIndex"]
    ctx.state = socket_client.emit("console:next-round")


@when("the host starts the next game")
def host_starts_next_game(ctx, socket_client):
    ctx.state = socket_client.emit("console:next-game")


@then(parsers.parse('the phase is "{phase}"'))
def then_phase(ctx, socket_client, phase: str):
    state = ctx.state or socket_client.state
    assert state["phase"] == phase


@then(parsers.parse('the step is "{step}"'))
def then_step(ctx, socket_client, step: str):
    state = ctx.state or socket_client.state
    assert state["step"] == step


@then(parsers.parse("host login is {value}"))
def then_host_login(ctx, socket_client, value: str):
    state = ctx.state or socket_client.state
    assert state["hostLoggedIn"] is (value.lower() == "true")


@then(parsers.parse("playback seconds is {seconds:g}"))
def then_playback_seconds(ctx, socket_client, seconds: float):
    state = ctx.state or socket_client.state
    assert state["playbackSeconds"] == seconds


@then("there are no players")
def then_no_players(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["players"] == []


@then("there are no tracks")
def then_no_tracks(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["tracks"] == []


@then("players are ordered by id")
def then_players_ordered(socket_client):
    ids = [player["id"] for player in socket_client.state["players"]]
    assert ids == sorted(ids)


@then(parsers.parse("the HTTP status is {status:d}"))
def then_http_status(ctx, status: int):
    assert ctx.response is not None
    assert ctx.response.status_code == status
    if status in {400, 409, 429}:
        assert ctx.response.content == b""


@then("the MusicKit token status is supported")
def then_token_status_supported(ctx):
    assert ctx.response is not None
    assert ctx.response.status_code in {200, 401, 500}


@then(parsers.parse('the retry-after header is "{value}"'))
def then_retry_after(ctx, value: str):
    assert ctx.response is not None
    assert ctx.response.headers.get("Retry-After") == value


@then(parsers.parse('selected playlist ids are "{ids}"'))
def then_selected_playlist_ids(ctx, socket_client, ids: str):
    state = ctx.state or socket_client.state
    expected = [item.strip() for item in ids.split(",") if item.strip()]
    assert state["selectedPlaylistIds"] == expected


@then(parsers.parse('playlist names are "{names}"'))
def then_playlist_names(ctx, socket_client, names: str):
    state = ctx.state or socket_client.state
    expected = [item.strip() for item in names.split(",") if item.strip()]
    assert state["playlists"] == expected


@then(parsers.parse("the track count is {count:d}"))
def then_track_count(ctx, socket_client, count: int):
    state = ctx.state or socket_client.state
    assert len(state["tracks"]) == count


@then("the current track is cleared")
def then_current_track_cleared(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["currentTrack"] is None
    assert state["currentTrackIndex"] == -1


@then(parsers.parse('the message contains "{text}"'))
def then_message_contains(ctx, socket_client, text: str):
    state = ctx.state or socket_client.state
    assert text in state["message"]


@then("the current track is one of the selected tracks")
def then_current_track_selected(ctx, socket_client):
    state = ctx.state or socket_client.state
    track_ids = {track["id"] for track in state["tracks"]}
    assert state["currentTrack"]["id"] in track_ids
    assert state["currentTrackIndex"] in range(len(state["tracks"]))


@then("has played current track is false")
def then_has_played_false(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["hasPlayedCurrentTrack"] is False


@then("has played current track is true")
def then_has_played_true(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["hasPlayedCurrentTrack"] is True


@then("all player scores are 0")
def then_all_scores_zero(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["players"]
    assert all(player["score"] == 0 for player in state["players"])


@then("game track order contains all selected track indexes")
def then_game_track_order_indexes(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert sorted(state["gameTrackOrder"]) == list(range(len(state["tracks"])))


@then(parsers.parse('player "{actor_id}" is joined'))
def then_player_joined(socket_client, actor_id: str):
    player = assert_player(socket_client.state, actor_id)
    assert player["joined"] is True


@then(parsers.parse('player "{actor_id}" is not joined'))
def then_player_not_joined(socket_client, actor_id: str):
    player = assert_player(socket_client.state, actor_id)
    assert player["joined"] is False


@then(parsers.parse('answerer is "{actor_id}"'))
def then_answerer(ctx, socket_client, actor_id: str):
    state = ctx.state or socket_client.state
    assert state["answererId"] == actor_id


@then("there is no answerer")
def then_no_answerer(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["answererId"] is None


@then(parsers.parse('last result is "{result}"'))
def then_last_result(ctx, socket_client, result: str):
    state = ctx.state or socket_client.state
    assert state["lastResult"] == result


@then("there is no last result")
def then_no_last_result(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["lastResult"] is None


@then(parsers.parse('player "{actor_id}" score is {score:d}'))
def then_player_score(socket_client, actor_id: str, score: int):
    player = assert_player(socket_client.state, actor_id)
    assert player["score"] == score


@then("there is no current track")
def then_no_current_track(ctx, socket_client):
    state = ctx.state or socket_client.state
    assert state["currentTrack"] is None
    assert state["currentTrackIndex"] == -1


@then(parsers.parse("the current game order index is {index:d}"))
def then_current_order_index(ctx, socket_client, index: int):
    state = ctx.state or socket_client.state
    assert state["currentGameTrackOrderIndex"] == index


@then("the current track follows game track order")
def then_current_track_follows_order(ctx, socket_client):
    state = ctx.state or socket_client.state
    expected_track_index = state["gameTrackOrder"][state["currentGameTrackOrderIndex"]]
    assert state["currentTrackIndex"] == expected_track_index
    assert state["currentTrack"] == state["tracks"][expected_track_index]
