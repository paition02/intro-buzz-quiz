"""UI-only playback regressions. No fallback socket actions or human-delay sleeps."""

from __future__ import annotations

import json
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import pytest
from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, expect
from pytest_bdd import given, parsers, scenarios, then, when
from frontend.musickit_mock import set_musickit_library_data


# Real browser events are sampled at 10ms. Duration tolerance is the smaller
# of 250ms and half the requested duration (50ms for a 100ms intro).
# Exact 1ms ordering still requires a separate controlled-clock test.
TIMING_TOLERANCE_SECONDS = 0.25
STOP_DEADLINE_MS = 1000


scenarios(
    "../../features/frontend/intro_controls.feature",
    "../../features/frontend/reset_and_logout.feature",
    "../../features/frontend/games_and_jackets.feature",
    "../../features/frontend/repetition_and_fault_boundaries.feature",
    "../../features/frontend/library_inputs.feature",
    "../../features/frontend/sdk_observable_contract.feature",
    "../../features/frontend/ui_boundaries.feature",
    "../../features/frontend/sdk_failures.feature",
    "../../features/frontend/authorization_recovery.feature",
)


@pytest.fixture
def playback_probe(frontend_page: Page, socket_client, tmp_path):
    probe = {"completed": [], "round_id": None, "active": None}
    yield probe
    # Keep evidence for failures, without recording tokens, requests, or SDK internals.
    if not frontend_page.is_closed():
        snapshot = frontend_page.evaluate("() => window.__introProbe ? ({samples: window.__introProbe.samples, errors: window.__introProbe.errors}) : null")
        (tmp_path / "playback-observation.json").write_text(
            json.dumps({"probe": probe, "media": snapshot, "state": socket_client.state}, ensure_ascii=False, indent=2)
        )
        frontend_page.evaluate("() => { window.__introProbe?.releasePlay?.(); window.__introProbe?.releaseAll(); window.__introProbe?.dispose(); }")


def _wait_state(socket_client, **expected):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if all(socket_client.state.get(key) == value for key, value in expected.items()):
            return socket_client.state
        socket_client.sleep(0.02)
    raise AssertionError(f"expected {expected}, received {socket_client.state}")


def _set_seconds(page: Page, seconds: float):
    slider = page.get_by_role("slider", name="再生秒数", exact=True)
    slider.focus()
    # Keyboard input uses the same component callbacks as pointer input and can
    # represent 0.1 exactly without clicking the coincident min/max ring position.
    current = float(slider.get_attribute("aria-valuenow"))
    difference = round((seconds - current) * 10)
    for _ in range(abs(difference)):
        slider.press("ArrowRight" if difference > 0 else "ArrowLeft")
    expect(slider).to_have_attribute("aria-valuenow", f"{seconds:g}")


def _assert_stopped(page: Page):
    try:
        page.wait_for_function("() => !MusicKit.getInstance().isPlaying", timeout=STOP_DEADLINE_MS)
    except PlaywrightTimeoutError as error:
        evidence = page.evaluate("() => window.__introProbe.samples.slice(-20)")
        raise AssertionError(f"media did not stop within {STOP_DEADLINE_MS}ms: {evidence}") from error
    before = page.evaluate("() => window.__introProbe.sample()")
    page.wait_for_timeout(150)
    after = page.evaluate("() => window.__introProbe.sample()")
    assert not after["playing"], after
    # A rewind after pausing is allowed; continued forward motion is not.
    assert after["position"] <= before["position"] + 0.05, (before, after)


@given(parsers.parse('a selected intro with an observed MusicKit player and participant "{actor}"'))
def selected_intro(frontend_page, socket_client, http, playback_probe, actor):
    frontend_page.goto("/console")
    frontend_page.get_by_role("button", name="ログイン", exact=True).click()
    playlist = frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)
    expect(playlist).to_be_visible()
    playlist.click()
    expect(frontend_page.get_by_text("1件のプレイリスト、3曲を選択中", exact=True)).to_be_visible()
    response = http.post(f"/api/act/{actor}")
    assert response.status_code == 200
    frontend_page.evaluate(Path(__file__).with_name("playback_observer.js").read_text())


@given(parsers.parse('a prepared intro with an observed MusicKit player and participant "{actor}"'))
def prepared_intro(frontend_page, socket_client, http, playback_probe, actor):
    selected_intro(frontend_page, socket_client, http, playback_probe, actor)
    frontend_page.get_by_role("button", name="イントロで開始", exact=True).click()
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=10000)
    state = _wait_state(socket_client, phase="game", step="beforePlayback")
    playback_probe["round_id"] = state["shuffledTrackIds"][state["roundIndex"]]
    playback_probe["round_index"] = state["roundIndex"]
    _assert_stopped(frontend_page)


@given(parsers.parse('the next SDK "{method}" operation has fault "{mode}"'))
@when(parsers.parse('the next SDK "{method}" operation has fault "{mode}"'))
def arm_sdk(frontend_page, method, mode):
    frontend_page.evaluate("({method, mode}) => window.__introProbe.arm(method, mode)", {"method": method, "mode": mode})


@then(parsers.parse('the SDK "{method}" operation has been attempted'))
def sdk_attempted(frontend_page, method):
    frontend_page.wait_for_function("method => window.__introProbe.faults[method].called", arg=method, timeout=5000)


@when(parsers.parse('the SDK "{method}" operation is released'))
def release_sdk(frontend_page, method):
    sdk_attempted(frontend_page, method)
    frontend_page.evaluate("method => window.__introProbe.faults[method].release()", method)


@then(parsers.parse('the SDK "{method}" failure is visible and reset stays usable'))
def sdk_error(frontend_page, method):
    sdk_attempted(frontend_page, method)
    expect(frontend_page.get_by_text(f"Injected {method} failure", exact=True).first).to_be_visible(timeout=5000)
    expect(frontend_page.get_by_role("button", name="リセット", exact=True)).to_be_enabled()


@then("the prepared track remains playable despite the optional preload fault")
def playable_without_preload(frontend_page, socket_client, playback_probe):
    state = _wait_state(socket_client, phase="game", step="beforePlayback")
    playback_probe["round_id"] = state["shuffledTrackIds"][state["roundIndex"]]
    playback_probe["round_index"] = state["roundIndex"]
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=3000)
    replay_sequence(frontend_page, socket_client, playback_probe, "0.5")


@then("a released obsolete load cannot audibly restart the reset game")
def obsolete_load_silent(frontend_page, socket_client):
    frontend_page.wait_for_timeout(1000)
    _assert_stopped(frontend_page)
    state = socket_client.state
    assert state["tracks"] == [] and state["answererId"] is None
    assert state["phase"] in {"ready", "initialization"}
    samples = frontend_page.evaluate("() => window.__introProbe.samples.filter(s => s.at >= window.__resetMark)")
    assert not any(s["playing"] and s["volume"] > 0 for s in samples), samples


@when("the host marks and resets the actual console")
def mark_reset(frontend_page):
    frontend_page.evaluate("() => { window.__resetMark = performance.now(); }")
    click_actual(frontend_page, "リセット")


@then("the actual console permits selecting and starting a new game")
def new_game_after_reset(frontend_page, socket_client, playback_probe):
    _wait_state(socket_client, phase="ready")
    button = frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)
    button.click(timeout=3000)
    expect(frontend_page.get_by_text("1件のプレイリスト、3曲を選択中", exact=True)).to_be_visible(timeout=5000)
    click_actual(frontend_page, "イントロで開始")
    state = _wait_state(socket_client, step="beforePlayback")
    playback_probe["round_id"] = state["shuffledTrackIds"][state["roundIndex"]]
    playback_probe["round_index"] = state["roundIndex"]
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
    replay_sequence(frontend_page, socket_client, playback_probe, "0.5")


@when(parsers.parse('the host clicks the actual "{label}" button'))
def click_actual(frontend_page, label):
    frontend_page.get_by_role("button", name=label, exact=True).click(timeout=5000)


@when(parsers.parse("the host starts an observed {seconds:g} second intro"))
def start_intro(frontend_page, socket_client, playback_probe, seconds):
    _set_seconds(frontend_page, seconds)
    mark = frontend_page.evaluate("() => window.__introProbe.mark()")
    media_duration = frontend_page.evaluate("MusicKit.getInstance().currentPlaybackDuration")
    limit = min(seconds, media_duration) if media_duration and media_duration > 0 else seconds
    playback_probe["active"] = {"mark": mark, "seconds": limit, "requested_seconds": seconds}
    click_actual(frontend_page, "再生")
    _wait_state(socket_client, phase="game", step="playing")
    frontend_page.wait_for_function(
        "({mark, id}) => window.__introProbe.samples.some(s => s.at >= mark && s.playing && s.id === id && s.volume > 0)",
        arg={"mark": mark, "id": playback_probe["round_id"]}, timeout=5000,
    )


@when(parsers.parse('the host replays the same track for "{sequence}" seconds'))
def replay_sequence(frontend_page, socket_client, playback_probe, sequence):
    for seconds in map(float, sequence.split(",")):
        start_intro(frontend_page, socket_client, playback_probe, seconds)
        _wait_state(socket_client, phase="game", step="beforePlayback")
        _assert_stopped(frontend_page)
        expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
        active = playback_probe["active"]
        samples = frontend_page.evaluate("mark => window.__introProbe.samples.filter(s => s.at >= mark)", active["mark"])
        played = [s for s in samples if s["playing"] and s["volume"] > 0]
        assert played, samples
        assert {s["id"] for s in played} == {playback_probe["round_id"]}, played
        assert played[0]["position"] <= min(0.15, seconds / 2), played[0]
        stopped = next(s for s in samples if s["at"] > played[-1]["at"] and not s["playing"])
        duration = (stopped["at"] - played[0]["at"]) / 1000
        limit = active['seconds']
        assert abs(duration - limit) <= min(TIMING_TOLERANCE_SECONDS, limit / 2), {"requested": seconds, "expected": limit, "observed": duration, "samples": samples}
        assert max(s["position"] for s in played) > min(seconds / 3, 0.1), played
        assert socket_client.state["roundIndex"] == playback_probe["round_index"]
        playback_probe["completed"].append({"seconds": seconds, "observed": duration})


@then("every completed intro started at the beginning and stopped within its duration tolerance")
def all_intros_verified(frontend_page, playback_probe):
    assert playback_probe["completed"]
    assert frontend_page.evaluate("() => window.__introProbe.errors") == []


@when(parsers.parse('participant "{actor}" buzzes during observed playback'))
def buzz(frontend_page, socket_client, http, actor):
    assert frontend_page.evaluate("() => MusicKit.getInstance().isPlaying")
    response = http.post(f"/api/act/{actor}")
    assert response.status_code == 200, response.status_code
    _wait_state(socket_client, step="answering", answererId=actor)


@then(parsers.parse('the media stops and participant "{actor}" keeps the answer rights'))
def stopped_answering(frontend_page, socket_client, actor):
    _assert_stopped(frontend_page)
    assert socket_client.state["step"] == "answering"
    assert socket_client.state["answererId"] == actor


@then("the same round becomes playable without changing the score")
def playable_again(frontend_page, socket_client, playback_probe):
    state = _wait_state(socket_client, step="beforePlayback", answererId=None)
    assert state["roundIndex"] == playback_probe["round_index"]
    assert state["shuffledTrackIds"][state["roundIndex"]] == playback_probe["round_id"]
    assert all(player["score"] == 0 for player in state["players"])
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
    _assert_stopped(frontend_page)


@given("the next MusicKit play promise is held after media playback starts")
@when("the next MusicKit play promise is held after media playback starts")
def hold_play(frontend_page):
    frontend_page.evaluate("() => window.__introProbe.holdNextPlay()")


@when("the held MusicKit play promise is released")
def release_play(frontend_page):
    assert frontend_page.evaluate("() => window.__introProbe.playHeld")
    frontend_page.evaluate("() => window.__introProbe.releasePlay()")


@then("the intro stops by its media deadline before the held promise is released")
def stopped_by_deadline(frontend_page, socket_client, playback_probe):
    assert frontend_page.evaluate("() => window.__introProbe.playHeld")
    active = playback_probe["active"]
    frontend_page.wait_for_function(
        "({mark, seconds, tolerance}) => { const first = window.__introProbe.samples.find(s => s.at >= mark && s.playing); return first && performance.now() >= first.at + (seconds + tolerance) * 1000; }",
        arg={**active, "tolerance": TIMING_TOLERANCE_SECONDS}, timeout=5000,
    )
    observed = frontend_page.evaluate("() => window.__introProbe.sample()")
    assert not observed["playing"], {"deadline": active, "observed": observed}
    _wait_state(socket_client, step="beforePlayback")


@then("the reset state is silent before the held promise is released")
@then("the reset state remains silent after the old intro deadline")
def reset_silent(frontend_page, socket_client, playback_probe):
    _assert_stopped(frontend_page)
    assert socket_client.state["phase"] in {"initialization", "ready"}
    assert socket_client.state["tracks"] == []
    assert socket_client.state["players"] == []
    assert socket_client.state["answererId"] is None
    # Observe beyond the original duration after all old callbacks can run.
    frontend_page.wait_for_timeout((playback_probe["active"]["seconds"] + 0.3) * 1000)
    _assert_stopped(frontend_page)
    assert socket_client.state["phase"] in {"initialization", "ready"}


@then("the current track keeps playing in reveal after the old intro deadline")
def reveal_survives(frontend_page, socket_client, playback_probe):
    _wait_state(socket_client, step="reveal")
    frontend_page.wait_for_function("() => MusicKit.getInstance().isPlaying", timeout=5000)
    frontend_page.wait_for_timeout(1700)
    assert socket_client.state["step"] == "reveal"
    assert frontend_page.evaluate("() => MusicKit.getInstance().nowPlayingItem.id") == playback_probe["round_id"]
    assert frontend_page.evaluate("() => MusicKit.getInstance().isPlaying")


@then(parsers.parse('results are silent and participant "{actor}" has 1 point'))
def silent_results(frontend_page, socket_client, actor):
    state = _wait_state(socket_client, step="results")
    _assert_stopped(frontend_page)
    assert next(p for p in state["players"] if p["id"] == actor)["score"] == 1


@when("the host opens and closes track information during playback")
def info_during_playback(frontend_page):
    click_actual(frontend_page, "曲情報を開く")
    click_actual(frontend_page, "曲情報を閉じる")


@then("the active intro stops at its original deadline")
def active_deadline(frontend_page, socket_client, playback_probe):
    active = playback_probe["active"]
    _wait_state(socket_client, step="beforePlayback")
    _assert_stopped(frontend_page)
    samples = frontend_page.evaluate("mark => window.__introProbe.samples.filter(s => s.at >= mark)", active["mark"])
    played = [s for s in samples if s["playing"] and s["volume"] > 0]
    assert played
    stopped = next(s for s in samples if s["at"] > played[-1]["at"] and not s["playing"])
    assert abs((stopped["at"] - played[0]["at"]) / 1000 - active["seconds"]) <= TIMING_TOLERANCE_SECONDS
    assert {s["id"] for s in played} == {playback_probe["round_id"]}
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)


@when("the host briefly loses and restores the socket connection")
def offline_during_playback(frontend_page):
    frontend_page.context.set_offline(True)
    frontend_page.wait_for_timeout(600)
    frontend_page.context.set_offline(False)


@when("a gameboard is opened closed and reopened during playback")
def reopen_board(frontend_page):
    board = frontend_page.context.new_page()
    try:
        board.goto("/gameboard")
        board.reload()
    finally:
        board.close()


@when(parsers.parse('the host sends the answer input action "{action}"'))
def answer_input(frontend_page, action):
    field = frontend_page.get_by_role("combobox", name="回答", exact=True)
    expect(field).to_be_enabled(timeout=5000)
    if action == "IME Enter":
        field.fill("Track")
        expect(frontend_page.get_by_role("option").first).to_be_visible()
        field.dispatch_event("keydown", {"key": "Enter", "code": "Enter", "isComposing": True, "bubbles": True})
    elif action == "whitespace Enter":
        field.fill("   ")
        field.press("Enter")
    elif action == "no-match arrows Enter":
        field.fill("zzzzzzzzzzzzzzzzzz")
        expect(frontend_page.get_by_role("option")).to_have_count(0)
        for key in ["ArrowDown", "ArrowUp", "Enter"]:
            field.press(key)
    elif action == "Escape":
        field.fill("Track")
        field.press("Escape")
        expect(field).to_have_value("")
        expect(frontend_page.get_by_role("option")).to_have_count(0)
    else:
        raise AssertionError(action)


@then("the input action does not judge or clear the answer rights")
def input_no_judgment(frontend_page, socket_client):
    frontend_page.wait_for_timeout(100)
    state = socket_client.state
    assert state["step"] == "answering" and state["answererId"] == "player-1"
    assert all(p["score"] == 0 for p in state["players"])


@when("the host enters an answer without selecting a candidate")
def unfinished_answer(frontend_page):
    frontend_page.get_by_role("combobox", name="回答", exact=True).fill("Track")
    expect(frontend_page.get_by_role("option").first).to_be_visible()


@then("the next answer opportunity has no previous answer text")
def empty_next_answer(frontend_page, socket_client, http):
    _wait_state(socket_client, step="beforePlayback")
    assert http.post("/api/act/player-1").status_code == 200
    _wait_state(socket_client, step="answering")
    expect(frontend_page.get_by_role("combobox", name="回答", exact=True)).to_have_value("")
    expect(frontend_page.get_by_role("option")).to_have_count(0)


@when(parsers.parse('the host rapidly clicks "{label}" {count:d} times'))
def rapid_click(frontend_page, label, count):
    button = frontend_page.get_by_role("button", name=label, exact=True)
    expect(button).to_be_enabled(timeout=5000)
    # Same-turn clicks deliberately exercise React state/disabled propagation.
    button.evaluate("(node, count) => { for (let i = 0; i < count; i++) node.click(); }", count)


@then("one correct judgment and one result sound are produced")
def one_correct(frontend_page, socket_client):
    _wait_state(socket_client, step="reveal")
    assert next(p for p in socket_client.state["players"] if p["id"] == "player-1")["score"] == 1
    # The correct sound contains two notes; observe one audio context, not just score.
    assert frontend_page.evaluate("() => window.__introBuzzAudioEvents.filter(e => e.type === 'context').length") == 1


@then("only the immediately next round is prepared silently")
def only_next(frontend_page, socket_client, playback_probe):
    state = _wait_state(socket_client, step="beforePlayback")
    assert state["roundIndex"] == playback_probe["round_index"] + 1
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
    _assert_stopped(frontend_page)
    assert frontend_page.evaluate("() => MusicKit.getInstance().nowPlayingItem.id") == state["shuffledTrackIds"][state["roundIndex"]]


@then("the current track is being revealed")
def now_revealed(frontend_page, socket_client, playback_probe):
    _wait_state(socket_client, step="reveal")
    frontend_page.wait_for_function("id => MusicKit.getInstance().isPlaying && MusicKit.getInstance().nowPlayingItem?.id === id", arg=playback_probe["round_id"], timeout=5000)


@when(parsers.parse('the host changes the slider by "{change}"'))
def slider_change(frontend_page, change):
    slider = frontend_page.get_by_role("slider", name="再生秒数")
    if change == "minimum":
        _set_seconds(frontend_page, 0.1)
        slider.press("ArrowLeft")
        expect(slider).to_have_attribute("aria-valuenow", "0.1")
    elif change == "maximum":
        _set_seconds(frontend_page, 30)
        slider.press("ArrowRight")
        expect(slider).to_have_attribute("aria-valuenow", "30")
    elif change == "cancel":
        slider.dispatch_event("pointercancel", {"pointerId": 1})
        _set_seconds(frontend_page, 1)
    else:
        raise AssertionError(change)


@then("slider input does not start audio or advance the round")
def slider_no_play(frontend_page, socket_client, playback_probe):
    _assert_stopped(frontend_page)
    assert socket_client.state["step"] == "beforePlayback"
    assert socket_client.state["roundIndex"] == playback_probe["round_index"]


@given(parsers.parse('an observed console with {count:d} selected tracks'))
def selected_track_count(frontend_page, socket_client, playback_probe, count):
    set_musickit_library_data(frontend_page, {"playlist-a": [f"track-{i+1}" for i in range(count)]})
    frontend_page.goto("/console")
    click_actual(frontend_page, "ログイン")
    click_actual(frontend_page, "Spec Playlist A")
    expect(frontend_page.get_by_text(f"1件のプレイリスト、{count}曲を選択中", exact=True)).to_be_visible(timeout=5000)
    frontend_page.evaluate(Path(__file__).with_name("playback_observer.js").read_text())


@when(parsers.parse('the observed console starts "{mode}" mode'))
def start_mode(frontend_page, socket_client, playback_probe, mode):
    click_actual(frontend_page, "イントロで開始" if mode == "intro" else "ジャケットで開始")
    state = _wait_state(socket_client, step="beforePlayback", quizMode=mode)
    if mode == "intro":
        expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
        playback_probe["round_id"] = state["shuffledTrackIds"][state["roundIndex"]]
        playback_probe["round_index"] = state["roundIndex"]
    else:
        expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_be_visible()
        expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_have_count(0)
        _assert_album_prepared(frontend_page, state)
    _assert_stopped(frontend_page)


def _revealed_ids(frontend_page, state):
    if state["quizMode"] == "intro":
        return [state["shuffledTrackIds"][state["roundIndex"]]]
    album = next(a for a in state["albums"] if a["id"] == state["shuffledAlbumIds"][state["roundAlbumIndex"]])
    track = album["trackIds"][0]
    mock = getattr(frontend_page, "music_kit_api_mock")
    return list(mock.data.albums["album-" + track].track_ids)


def _assert_album_prepared(page, state):
    expected = _revealed_ids(page, state)
    page.wait_for_function("() => !MusicKit.getInstance().isPlaying || MusicKit.getInstance().volume===0", timeout=STOP_DEADLINE_MS)
    mark = page.evaluate("window.__introProbe.mark()")
    # Warm-up is allowed only at zero volume. Wait for the current album's
    # muted playback and completed rewind, not a transient stop before loading.
    page.wait_for_function("""ids => {
      const mk=MusicKit.getInstance();
      return mk.nowPlayingItem?.id===ids[0] && !mk.isPlaying && mk.volume===1
        && mk.currentPlaybackTime===0
        && JSON.stringify(mk.queue.items.map(i=>i.id))===JSON.stringify(ids)
        && window.__introProbe.samples.some(s=>s.id===ids[0] && s.playing && s.volume===0);
    }""", arg=expected, timeout=10000)
    samples=page.evaluate("mark=>window.__introProbe.samples.filter(s=>s.at>=mark && s.playing)", mark)
    assert all(s['volume']==0 for s in samples), samples
    _assert_stopped(page)


@then("the reveal plays the expected full track or album queue")
def expected_reveal(frontend_page, socket_client):
    state = _wait_state(socket_client, step="reveal")
    expected = _revealed_ids(frontend_page, state)
    frontend_page.wait_for_function("id => MusicKit.getInstance().isPlaying && MusicKit.getInstance().nowPlayingItem?.id === id", arg=expected[0], timeout=5000)
    actual = frontend_page.evaluate("() => ({ids: MusicKit.getInstance().queue.items.map(i => i.id), repeat: MusicKit.getInstance().repeatMode, one: MusicKit.PlayerRepeatMode.one, all: MusicKit.PlayerRepeatMode.all})")
    if state["quizMode"] == "jacket":
        assert actual["ids"] == expected
        assert actual["repeat"] == actual["all"]
    else:
        assert actual["repeat"] == actual["one"]


@then("the jacket returns to its own first track after a full album cycle")
def album_cycle(frontend_page, socket_client):
    ids = _revealed_ids(frontend_page, socket_client.state)
    assert len(ids) >= 2
    frontend_page.wait_for_function("id => MusicKit.getInstance().isPlaying && MusicKit.getInstance().nowPlayingItem?.id === id", arg=ids[-1], timeout=10000)
    frontend_page.wait_for_function("id => MusicKit.getInstance().isPlaying && MusicKit.getInstance().nowPlayingItem?.id === id", arg=ids[0], timeout=10000)
    assert socket_client.state["step"] == "reveal"


@then("the observed results contain no active media")
def no_results_media(frontend_page, socket_client):
    _wait_state(socket_client, step="results")
    _assert_stopped(frontend_page)
    frontend_page.wait_for_timeout(2300)
    _assert_stopped(frontend_page)


@when(parsers.parse('the observed console finishes all rounds in "{mode}" mode'))
def finish_rounds(frontend_page, socket_client, playback_probe, mode):
    start_mode(frontend_page, socket_client, playback_probe, mode)
    state = socket_client.state
    ids_key = "shuffledTrackIds" if mode == "intro" else "shuffledAlbumIds"
    index_key = "roundIndex" if mode == "intro" else "roundAlbumIndex"
    order = list(state[ids_key])
    for index in range(len(order)):
        assert socket_client.state[index_key] == index
        assert socket_client.state[ids_key] == order
        if mode == "intro":
            playback_probe["round_index"] = index
            playback_probe["round_id"] = order[index]
            replay_sequence(frontend_page, socket_client, playback_probe, "0.5")
        else:
            _assert_album_prepared(frontend_page, socket_client.state)
        click_actual(frontend_page, "ギブアップ")
        expected_reveal(frontend_page, socket_client)
        if index < len(order) - 1:
            click_actual(frontend_page, "次のラウンドへ")
            _wait_state(socket_client, step="beforePlayback")
            if mode == "intro":
                expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
        else:
            expect(frontend_page.get_by_role("button", name="次のラウンドへ", exact=True)).to_be_disabled()
    click_actual(frontend_page, "結果発表へ")
    no_results_media(frontend_page, socket_client)


@when(parsers.parse('the observed console begins a subsequent "{mode}" game'))
def subsequent_game(frontend_page, socket_client, playback_probe, mode):
    click_actual(frontend_page, "次のゲームへ")
    _wait_state(socket_client, phase="ready")
    assert socket_client.state["players"] == []
    start_mode(frontend_page, socket_client, playback_probe, mode)
    if mode == "intro":
        replay_sequence(frontend_page, socket_client, playback_probe, "0.5")
    click_actual(frontend_page, "ギブアップ")
    expected_reveal(frontend_page, socket_client)


@when(parsers.parse('the jacket UI sets mode "{mode}" and grayscale "{gray}"'))
def set_jacket_ui(frontend_page, socket_client, mode, gray):
    frontend_page.get_by_role("combobox", name="隠し方").select_option(mode)
    _wait_state(socket_client, jacketMode=mode)
    checkbox = frontend_page.get_by_role("checkbox", name="白黒")
    # This controlled input is updated after the socket round trip. set_checked
    # checks synchronously immediately after the click, before React can update.
    if checkbox.is_checked() != (gray == "true"):
        checkbox.click()
    _wait_state(socket_client, jacketGrayscale=gray == "true")
    expect(checkbox).to_be_checked(checked=gray == "true")
    slider = frontend_page.get_by_role("slider", name="ヒントレベル")
    for _ in range(46):
        slider.press("ArrowRight")
    _wait_state(socket_client, jacketHintPercent=47)
    expect(slider).to_have_attribute("aria-valuenow", "47")


@then("jacket judging preserves settings and the next round resets only its hint")
def jacket_wrong_and_next(frontend_page, socket_client, http):
    state = socket_client.state
    settings = {key: state[key] for key in ("jacketMode", "jacketGrayscale", "jacketHintPercent")}
    assert http.post("/api/act/player-1").status_code == 200
    _wait_state(socket_client, step="answering")
    click_actual(frontend_page, "不正解")
    _wait_state(socket_client, step="beforePlayback")
    assert all(socket_client.state[key] == value for key, value in settings.items())
    _assert_stopped(frontend_page)
    click_actual(frontend_page, "ギブアップ")
    expected_reveal(frontend_page, socket_client)
    click_actual(frontend_page, "次のラウンドへ")
    _wait_state(socket_client, step="beforePlayback", jacketHintPercent=1)
    _assert_album_prepared(frontend_page, socket_client.state)
    assert socket_client.state["jacketMode"] == settings["jacketMode"]
    assert socket_client.state["jacketGrayscale"] == settings["jacketGrayscale"]
    expect(frontend_page.get_by_role("slider", name="ヒントレベル")).to_have_attribute("aria-valuenow", "1")


@given("library track responses are limited to fifty items per page")
def fifty_item_pages(frontend_page):
    def limit_page(route):
        url = urlsplit(route.request.url)
        query = dict(parse_qsl(url.query))
        query["limit"] = "50"
        route.fallback(url=urlunsplit(url._replace(query=urlencode(query))))
    frontend_page.route("**/api.music.apple.com/v1/me/library/playlists/*/tracks*", limit_page)


@then(parsers.parse("the library selection contains exactly {count:d} distinct track IDs"))
def exact_track_ids(frontend_page, socket_client, count):
    expected = {f"track-{i+1}" for i in range(count)}
    state = socket_client.state
    assert {t["id"] for t in state["tracks"]} == expected
    assert len(state["tracks"]) == count
    button = frontend_page.get_by_role("button", name="イントロで開始", exact=True)
    if count:
        expect(button).to_be_enabled()
        click_actual(frontend_page, "イントロで開始")
        _wait_state(socket_client, step="beforePlayback")
        expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
        assert frontend_page.evaluate("() => MusicKit.getInstance().nowPlayingItem.id") in expected
    else:
        expect(button).to_be_disabled()
        expect(frontend_page.get_by_role("button", name="ジャケットで開始", exact=True)).to_be_disabled()


@given("the observed library has overlapping playlists")
def overlapping_library(frontend_page, playback_probe):
    set_musickit_library_data(frontend_page, {"playlist-a": ["track-1", "track-2"], "playlist-b": ["track-2", "track-3"]})
    frontend_page.goto("/console")
    click_actual(frontend_page, "ログイン")
    expect(frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)).to_be_visible()
    frontend_page.evaluate(Path(__file__).with_name("playback_observer.js").read_text())


@when("the host selects both playlists and deselects the first")
def deselect_overlap(frontend_page):
    click_actual(frontend_page, "Spec Playlist A")
    expect(frontend_page.get_by_text("1件のプレイリスト、2曲を選択中", exact=True)).to_be_visible()
    click_actual(frontend_page, "Spec Playlist B")
    expect(frontend_page.get_by_text("2件のプレイリスト、3曲を選択中", exact=True)).to_be_visible()
    click_actual(frontend_page, "Spec Playlist A")


@then("the overlapping track remains selected exactly once")
def overlap_retained(frontend_page, socket_client):
    expect(frontend_page.get_by_text("1件のプレイリスト、2曲を選択中", exact=True)).to_be_visible()
    state = socket_client.state
    assert state["selectedPlaylistIds"] == ["playlist-b"]
    assert sorted(t["id"] for t in state["tracks"]) == ["track-2", "track-3"]


@when("the first playlist track request is held while the host resets")
def reset_playlist_request(frontend_page, socket_client):
    held = []
    def hold_track_response(route):
        if route.request.method == "GET" and not held:
            held.append(route)
        else:
            route.fallback()
    frontend_page.route("**/api.music.apple.com/v1/me/library/playlists/playlist-a/tracks*", hold_track_response)
    # Recreate the UI query cache so a previous hidden-panel prefetch cannot
    # satisfy this selection before the deliberately deferred HTTP response.
    frontend_page.reload()
    click_actual(frontend_page, "Spec Playlist A")
    deadline = time.monotonic() + 5
    while not held and time.monotonic() < deadline:
        socket_client.sleep(0.02)
    assert held, "playlist request never reached the HTTP delay gate"
    setattr(frontend_page, "held_playlist_routes", held)
    click_actual(frontend_page, "リセット")


@when("the old playlist track request is released")
def release_tracks(frontend_page, socket_client):
    _wait_state(socket_client, phase="ready")
    for route in getattr(frontend_page, "held_playlist_routes"):
        route.fallback()


@then("the reset library selection stays empty")
def reset_selection_empty(frontend_page, socket_client):
    frontend_page.wait_for_timeout(500)
    assert socket_client.state["tracks"] == []
    assert socket_client.state["selectedPlaylistIds"] == []
    expect(frontend_page.get_by_role("button", name="イントロで開始", exact=True)).to_be_disabled()


@when(parsers.parse("the host repeats {count:d} intros lasting {seconds:g} seconds"))
def repeat_many(frontend_page, socket_client, playback_probe, count, seconds):
    replay_sequence(frontend_page, socket_client, playback_probe, ",".join([str(seconds)] * count))
    assert len(playback_probe["completed"]) == count


@when(parsers.parse("the host repeats buzzing and wrong judgment {count:d} times"))
def repeated_wrong_ui(frontend_page, socket_client, http, playback_probe, count):
    for _ in range(count):
        start_intro(frontend_page, socket_client, playback_probe, 1.5)
        buzz(frontend_page, socket_client, http, "player-1")
        stopped_answering(frontend_page, socket_client, "player-1")
        click_actual(frontend_page, "不正解")
        playable_again(frontend_page, socket_client, playback_probe)
    replay_sequence(frontend_page, socket_client, playback_probe, "0.5")


@when("the host clicks play repeatedly in the same event turn")
def rapid_play(frontend_page, playback_probe):
    _set_seconds(frontend_page, 0.5)
    mark = frontend_page.evaluate("() => window.__introProbe.mark()")
    playback_probe["active"] = {"mark": mark, "seconds": 0.5}
    rapid_click(frontend_page, "再生", 3)


@then("the repeated play clicks produce one bounded playback interval")
def one_interval(frontend_page, socket_client, playback_probe):
    _wait_state(socket_client, step="playing")
    active_deadline(frontend_page, socket_client, playback_probe)
    samples = frontend_page.evaluate("mark => window.__introProbe.samples.filter(s => s.at >= mark)", playback_probe["active"]["mark"])
    starts = 0
    previous = False
    for sample in samples:
        if sample["playing"] and not previous:
            starts += 1
        previous = sample["playing"]
    assert starts == 1, samples


@when("the host disables result sound creation and judges correct")
def broken_effect_sound(frontend_page):
    frontend_page.evaluate("() => { window.AudioContext = window.webkitAudioContext = class { constructor() { throw new Error('Audio output unavailable'); } }; }")
    click_actual(frontend_page, "正解")


@then("correct feedback still reaches reveal with one point")
def feedback_survives(frontend_page, socket_client):
    _wait_state(socket_client, step="reveal")
    assert next(p for p in socket_client.state["players"] if p["id"] == "player-1")["score"] == 1
    frontend_page.wait_for_function("() => MusicKit.getInstance().isPlaying", timeout=5000)


@when(parsers.parse('the host reaches observed stage "{stage}"'))
def reach_observed_stage(frontend_page, socket_client, http, playback_probe, stage):
    if stage == "beforePlayback":
        return
    if stage == "played":
        replay_sequence(frontend_page, socket_client, playback_probe, "0.5")
        return
    if stage in {"playing", "answering", "wrong", "correct"}:
        start_intro(frontend_page, socket_client, playback_probe, 1.5)
        if stage == "playing":
            return
        buzz(frontend_page, socket_client, http, "player-1")
        stopped_answering(frontend_page, socket_client, "player-1")
        if stage != "answering":
            click_actual(frontend_page, "不正解" if stage == "wrong" else "正解")
            _wait_state(socket_client, step=stage)
    elif stage in {"reveal", "results"}:
        click_actual(frontend_page, "ギブアップ")
        expected_reveal(frontend_page, socket_client)
        if stage == "results":
            click_actual(frontend_page, "結果発表へ")
            _wait_state(socket_client, step="results")
    else:
        raise AssertionError(stage)


@then("reset stays silent after old feedback and playback timers expire")
def reset_past_timers(frontend_page, socket_client):
    _wait_state(socket_client, phase="ready")
    _assert_stopped(frontend_page)
    frontend_page.wait_for_timeout(2100)
    _assert_stopped(frontend_page)
    assert socket_client.state["phase"] == "ready"
    assert socket_client.state["tracks"] == []
    assert socket_client.state["players"] == []


@when("the host logs out during an observed intro")
def logout_playing(frontend_page):
    click_actual(frontend_page, "ログアウト")


@then("logout stops media and does not restart at the old deadline")
def logout_silent(frontend_page):
    expect(frontend_page.get_by_text("Apple Music 未ログイン", exact=True)).to_be_visible(timeout=5000)
    _assert_stopped(frontend_page)
    frontend_page.wait_for_timeout(1800)
    _assert_stopped(frontend_page)
    expect(frontend_page.get_by_role("button", name="ログイン", exact=True)).to_be_enabled()


@when("the host logs out while an initial load is deferred")
def logout_during_load(frontend_page):
    sdk_attempted(frontend_page, "setQueue")
    click_actual(frontend_page, "ログアウト")


@then("the delayed load after logout never starts audible media")
def logout_late_silent(frontend_page):
    expect(frontend_page.get_by_text("Apple Music 未ログイン", exact=True)).to_be_visible(timeout=5000)
    mark = frontend_page.evaluate("() => window.__introProbe.mark()")
    release_sdk(frontend_page, "setQueue")
    frontend_page.wait_for_timeout(1200)
    samples = frontend_page.evaluate("mark => window.__introProbe.samples.filter(s => s.at >= mark)", mark)
    assert not any(s["playing"] and s["volume"] > 0 for s in samples), samples
    _assert_stopped(frontend_page)


@then("a no-op play response is not presented as a successful intro")
def noop_play_error(frontend_page, socket_client):
    sdk_attempted(frontend_page, "play")
    frontend_page.wait_for_timeout(1800)
    samples = frontend_page.evaluate("() => window.__introProbe.samples")
    assert not any(s["playing"] and s["volume"] > 0 for s in samples[-100:])
    # Failure needs an observable explanation; returning to an ordinary ready
    # display would silently report an intro which never happened.
    expect(frontend_page.locator("p").filter(has_text="再生を開始できません")).to_be_visible(timeout=3000)
    expect(frontend_page.get_by_role("button", name="リセット", exact=True)).to_be_enabled()
    _wait_state(socket_client, step='beforePlayback')
    expect(frontend_page.get_by_role('button', name='再生', exact=True)).to_be_enabled()
    click_actual(frontend_page, '再生')
    frontend_page.wait_for_function('MusicKit.getInstance().isPlaying', timeout=5000)
    _wait_state(socket_client, step='beforePlayback')
    _assert_stopped(frontend_page)


@then("the wrong loaded song is rejected before enabling play")
def wrong_loaded_song(frontend_page):
    sdk_attempted(frontend_page, "setQueue")
    expect(frontend_page.get_by_text("曲を読み込めません", exact=True)).to_be_visible(timeout=5000)
    expect(frontend_page.get_by_role("button", name="ロード中", exact=True)).to_be_disabled()


@when(parsers.parse("the host sets media volume to {volume:g}"))
def set_volume(frontend_page, volume):
    frontend_page.evaluate("value => { MusicKit.getInstance().volume = value; }", volume)


@then(parsers.parse("the prepared media volume remains {volume:g}"))
def volume_restored(frontend_page, volume):
    expect(frontend_page.get_by_role("button", name="再生", exact=True)).to_be_enabled(timeout=5000)
    assert frontend_page.evaluate("() => MusicKit.getInstance().volume") == pytest.approx(volume)
    _assert_stopped(frontend_page)


@then("a failed warmup restores the original media volume")
def failed_mute_restored(frontend_page):
    sdk_error(frontend_page, "pause")
    assert frontend_page.evaluate("() => MusicKit.getInstance().volume") == pytest.approx(0.4)


@when("the host mutes during a deferred warmup")
def mute_pending(frontend_page):
    sdk_attempted(frontend_page, "pause")
    set_volume(frontend_page, 0)
    release_sdk(frontend_page, "pause")


@given("the observed console is unauthenticated")
def unauthenticated_console(frontend_page, playback_probe):
    frontend_page.goto("/console")
    expect(frontend_page.get_by_role("button", name="ログイン", exact=True)).to_be_enabled(timeout=5000)
    frontend_page.evaluate(Path(__file__).with_name("playback_observer.js").read_text())


@then("authorization failure remains unauthenticated and permits retry")
def auth_retry(frontend_page):
    expect(frontend_page.get_by_text("Apple Music 未ログイン", exact=True)).to_be_visible()
    expect(frontend_page.get_by_text("Injected authorize failure", exact=True).first).to_be_visible(timeout=5000)
    click_actual(frontend_page, "ログイン")
    expect(frontend_page.get_by_text("Apple Music ログイン済み", exact=True)).to_be_visible(timeout=5000)
    expect(frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)).to_be_visible(timeout=5000)
    expect(frontend_page.get_by_text("Injected authorize failure", exact=True)).to_have_count(0)


@given("the developer token endpoint fails until restored")
def token_failure(frontend_page):
    state = {"failing": True}
    def handle(route):
        if state["failing"]:
            route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "Injected token failure"}))
        else:
            route.fallback()
    frontend_page.route("**/api/token", handle)
    setattr(frontend_page, "token_fault", state)


@when("the host observes token failure and reloads after restoration")
def restore_token(frontend_page):
    frontend_page.goto("/console")
    expect(frontend_page.get_by_text("Injected token failure", exact=True)).to_be_visible(timeout=5000)
    getattr(frontend_page, "token_fault")["failing"] = False
    frontend_page.reload()
    click_actual(frontend_page, "ログイン")


@then("the restored console permits library selection")
def restored_library(frontend_page):
    expect(frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)).to_be_visible(timeout=5000)
    click_actual(frontend_page, "Spec Playlist A")
    expect(frontend_page.get_by_text("1件のプレイリスト、3曲を選択中", exact=True)).to_be_visible(timeout=5000)


@given(parsers.parse('library listing fails with HTTP {status:d} until restored'))
def failing_library(frontend_page, status):
    state = {"failing": True}
    def handler(route):
        if urlsplit(route.request.url).path != "/v1/me/library/playlists" or not state["failing"]:
            route.fallback()
        elif route.request.method == "OPTIONS":
            route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"})
        else:
            route.fulfill(status=status, headers={"Access-Control-Allow-Origin": "*"}, content_type="application/json", body=json.dumps({"errors": [{"detail": "Injected library failure"}], "message": "Injected library failure"}))
    frontend_page.route("**/api.music.apple.com/v1/me/library/playlists*", handler)
    setattr(frontend_page, "library_fault", state)


@when("the host attempts login with the broken library listing")
def login_broken_library(frontend_page):
    frontend_page.goto("/console")
    click_actual(frontend_page, "ログイン")


@then("library failure leaves a usable reload control and can recover")
def library_recovers(frontend_page):
    reload = frontend_page.get_by_role("button", name="再読み込み", exact=True)
    expect(reload).to_be_enabled(timeout=15000)
    expect(frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)).to_have_count(0)
    getattr(frontend_page, "library_fault")["failing"] = False
    reload.click()
    expect(frontend_page.get_by_role("button", name="Spec Playlist A", exact=True)).to_be_visible(timeout=5000)
    restored_library(frontend_page)
