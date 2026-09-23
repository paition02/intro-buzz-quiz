"""Backend portions of the scenario catalogue; deliberately not audio tests."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json

import httpx
import pytest
from pytest_bdd import given, when, then, parsers, scenarios

from backend.helpers import make_tracks

scenarios("../../features/contracts")


@pytest.fixture
def contract():
    return {}


def accepted(client, event, payload=None):
    state = client.emit("console:" + event, payload)
    assert client.last_ack["ok"], (event, client.last_ack)
    return state


def setup_game(client, http, mode="intro", count=3):
    accepted(client, "ready")
    for actor in ("P", "Q"):
        assert http.post("/api/act/" + actor).status_code == 200
    accepted(client, "select-playlists", {"selectedPlaylistIds": ["A"], "tracks": make_tracks(count)})
    accepted(client, "start", {"quizMode": mode})
    client.sleep(0.26)


def answer(client, http, actor="P"):
    if client.state["quizMode"] == "intro" and client.state["step"] == "beforePlayback":
        accepted(client, "play")
    assert http.post("/api/act/" + actor).status_code == 200
    client.wait_for_state(step="answering", answererId=actor)


def score(client, actor):
    return next(p["score"] for p in client.state["players"] if p["id"] == actor)


@given(parsers.parse('the contract state is "{state}"'))
def contract_state(socket_client, http, contract, state):
    if state == "initialization":
        pass
    elif state == "ready":
        accepted(socket_client, "ready")
    else:
        mode, step = state.split(":")
        setup_game(socket_client, http, mode)
        if step == "playing":
            accepted(socket_client, "play")
        elif step == "played":
            accepted(socket_client, "play")
            accepted(socket_client, "play-ended")
        elif step in {"answering", "wrong", "correct", "correct-reveal"}:
            answer(socket_client, http)
            if step != "answering":
                accepted(socket_client, "wrong" if step == "wrong" else "correct")
            if step == "correct-reveal":
                accepted(socket_client, "correct-feedback-ended")
        elif step in {"reveal", "results", "last-reveal"}:
            if step == "last-reveal":
                for _ in range(2):
                    accepted(socket_client, "give-up")
                    accepted(socket_client, "next-round")
            accepted(socket_client, "give-up")
            if step == "results":
                accepted(socket_client, "show-results")
        elif step != "before":
            raise AssertionError(f"unknown state {state}")
    contract["before"] = deepcopy(socket_client.state)


@when(parsers.parse('the contract sends rejected command "{event}"'))
def rejected_command(socket_client, contract, event):
    payload = {
        "start": {"quizMode": "intro"},
        "select-playlists": {"selectedPlaylistIds": ["B"], "tracks": make_tracks(1, 50)},
        "set-jacket-mode": {"jacketMode": "tileShuffle"},
        "set-jacket-grayscale": {"jacketGrayscale": False},
        "set-jacket-hint-percent": {"jacketHintPercent": 47},
    }.get(event)
    socket_client.emit("console:" + event, payload)
    assert socket_client.last_ack["ok"] is False
    assert socket_client.last_ack.get("error")


@then("the entire contract state is unchanged")
def unchanged(socket_client, contract):
    assert socket_client.state == contract["before"]


@when(parsers.parse('contract actor "{actor}" buzzes expecting {status:d}'))
def buzz_contract(http, socket_client, contract, actor, status):
    # Wait only when this scenario explicitly models an expired cooldown.
    socket_client.sleep(0.26)
    response = http.post("/api/act/" + actor)
    assert response.status_code == status
    assert response.content == b""
    if status == 200:
        socket_client.wait_for_state(answererId=actor, step="answering")
        contract["winner"] = actor


@then("the contract has exactly one answerer without changing scores")
def one_answerer(socket_client, contract):
    assert socket_client.state["answererId"] == contract["winner"]
    assert socket_client.state["players"] == contract["before"]["players"]


@when("both contract players buzz concurrently")
def concurrent_buzz(socket_client, contract):
    def press(actor):
        response = httpx.post(socket_client.server_url + "/api/act/" + actor)
        assert response.content == b""
        return actor, response.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(press, ("P", "Q")))
    assert sorted(status for _, status in responses) == [200, 204], responses
    contract["winner"] = next(actor for actor, status in responses if status == 200)
    socket_client.wait_for_state(step="answering", answererId=contract["winner"])


@when(parsers.parse('the contract applies competing judgments "{first}" then "{second}"'))
def competing_judgments(socket_client, contract, first, second):
    accepted(socket_client, first)
    state = deepcopy(socket_client.state)
    socket_client.emit("console:" + second)
    assert socket_client.last_ack["ok"] is False
    assert socket_client.state == state
    contract["judgment"] = first


@then("only the first judgment affects the contract score")
def first_judgment(socket_client, contract):
    first = contract["judgment"]
    assert score(socket_client, "P") == (1 if first == "correct" else 0)
    assert score(socket_client, "Q") == 0
    accepted(socket_client, first + "-feedback-ended")
    assert socket_client.state["step"] == ("reveal" if first == "correct" else "beforePlayback")


@when(parsers.parse("the contract repeats wrong answers {count:d} times"))
def repeated_wrong(socket_client, http, contract, count):
    index = socket_client.state["roundIndex"]
    for _ in range(count):
        answer(socket_client, http)
        accepted(socket_client, "wrong")
        accepted(socket_client, "wrong-feedback-ended")
        assert score(socket_client, "P") == 0
        assert socket_client.state["answererId"] is None
        assert socket_client.state["roundIndex"] == index
        socket_client.sleep(0.26)
    # No new playback: the played-round acceptance must survive wrong feedback.
    assert http.post("/api/act/Q").status_code == 200
    socket_client.wait_for_state(answererId="Q")
    accepted(socket_client, "correct")


@then("only the final contract answer scores")
def final_score(socket_client):
    assert score(socket_client, "P") == 0
    assert score(socket_client, "Q") == 1


@given(parsers.parse('a contract game with {count:d} tracks in "{mode}" mode'))
def sized_game(socket_client, http, count, mode):
    setup_game(socket_client, http, mode, count)


@when("the contract completes every round and starts another game")
def all_rounds(socket_client, http, contract):
    mode = socket_client.state["quizMode"]
    key = "shuffledTrackIds" if mode == "intro" else "shuffledAlbumIds"
    index_key = "roundIndex" if mode == "intro" else "roundAlbumIndex"
    order = list(socket_client.state[key])
    seen = []
    for i, item in enumerate(order):
        assert socket_client.state[index_key] == i
        assert socket_client.state[key] == order
        seen.append(socket_client.state[key][i])
        if mode == "intro":
            # The server must reset the 'has played' flag for every new round.
            assert http.post("/api/act/Q").status_code == 409
            accepted(socket_client, "play")
            accepted(socket_client, "play-ended")
        accepted(socket_client, "give-up")
        if i + 1 < len(order):
            accepted(socket_client, "next-round")
    assert seen == order and len(set(seen)) == len(order)
    before = deepcopy(socket_client.state)
    socket_client.emit("console:next-round")
    assert socket_client.last_ack["ok"] is False
    assert socket_client.state == before
    accepted(socket_client, "show-results")
    assert socket_client.state["roundIndex"] == -1
    selected = deepcopy(socket_client.state["tracks"])
    accepted(socket_client, "next-game")
    assert socket_client.state["tracks"] == selected
    assert socket_client.state["players"] == []
    assert http.post("/api/act/P").status_code == 200
    accepted(socket_client, "start", {"quizMode": mode})
    contract["expected_ids"] = set(order)
    contract["order_key"] = key


@then("the next contract game starts at zero with the original selection")
def next_game(socket_client, contract):
    state = socket_client.state
    assert state["step"] == "beforePlayback"
    assert state["answererId"] is None
    assert score(socket_client, "P") == 0
    assert set(state[contract["order_key"]]) == contract["expected_ids"]


@when("the contract resets twice")
def reset_twice(socket_client):
    accepted(socket_client, "reset")
    accepted(socket_client, "reset")


@then("the contract reset clears the game and permits a new selection")
def reset_clear(socket_client):
    state = socket_client.state
    assert (state["phase"], state["step"], state["quizMode"]) == ("initialization", "idle", None)
    for key in ("players", "tracks", "albums", "selectedPlaylistIds", "shuffledTrackIds", "shuffledAlbumIds"):
        assert state[key] == [], key
    assert state["answererId"] is None
    assert state["roundIndex"] == state["roundAlbumIndex"] == -1
    accepted(socket_client, "ready")
    accepted(socket_client, "select-playlists", {"selectedPlaylistIds": ["new"], "tracks": make_tracks(1, 100)})
    accepted(socket_client, "start", {"quizMode": "intro"})
    assert socket_client.state["shuffledTrackIds"] == ["track-100"]


@when(parsers.parse('the contract sets jacket mode "{mode}" and grayscale "{grayscale}"'))
def jacket_settings(socket_client, contract, mode, grayscale):
    accepted(socket_client, "set-jacket-mode", {"jacketMode": mode})
    accepted(socket_client, "set-jacket-grayscale", {"jacketGrayscale": grayscale == "true"})
    accepted(socket_client, "set-jacket-hint-percent", {"jacketHintPercent": 47})
    contract["settings"] = (mode, grayscale == "true")


@then("the jacket contract keeps settings after wrong and resets only the next hint")
def jacket_survives(socket_client, http, contract):
    album = socket_client.state["shuffledAlbumIds"][0]
    answer(socket_client, http)
    accepted(socket_client, "wrong")
    accepted(socket_client, "wrong-feedback-ended")
    assert socket_client.state["jacketHintPercent"] == 47
    assert socket_client.state["shuffledAlbumIds"][socket_client.state["roundAlbumIndex"]] == album
    accepted(socket_client, "give-up")
    accepted(socket_client, "next-round")
    assert socket_client.state["jacketHintPercent"] == 1
    assert (socket_client.state["jacketMode"], socket_client.state["jacketGrayscale"]) == contract["settings"]


@when(parsers.parse('the contract submits hint JSON {value} expecting {expected}'))
def hint_value(socket_client, value, expected):
    accepted(socket_client, "set-jacket-hint-percent", {"jacketHintPercent": 47})
    before = deepcopy(socket_client.state)
    socket_client.emit("console:set-jacket-hint-percent", {"jacketHintPercent": json.loads(value)})
    if expected == "rejected":
        assert socket_client.last_ack["ok"] is False
        assert socket_client.state == before
    else:
        assert socket_client.last_ack["ok"] is True
        assert socket_client.state["jacketHintPercent"] == int(expected)


@when("a no-reaction buzz is followed immediately by another answer opportunity")
def no_reaction(socket_client, http):
    assert http.post("/api/act/Q").status_code == 204
    accepted(socket_client, "wrong")
    accepted(socket_client, "wrong-feedback-ended")
    assert http.post("/api/act/Q").status_code == 200
    socket_client.wait_for_state(step="answering", answererId="Q")


@then("Q has the contract answer rights")
def q_answers(socket_client):
    assert socket_client.state["answererId"] == "Q"


@when(parsers.parse('the contract selects metadata variant "{variant}"'))
def select_metadata(socket_client, contract, variant):
    tracks = make_tracks(2)
    if variant == "same-title-different-id":
        tracks[1]["title"] = tracks[0]["title"]
    elif variant == "duplicate-id":
        tracks[1]["id"] = tracks[0]["id"]
    elif variant == "missing-id":
        tracks[1]["id"] = ""
    elif variant == "missing-title":
        tracks[1]["title"] = ""
    elif variant == "missing-artwork":
        for t in tracks:
            for key in list(t):
                if key.startswith("artwork"):
                    del t[key]
    elif variant == "missing-album":
        for t in tracks:
            t["albumName"] = ""
    elif variant == "same-album":
        for t in tracks:
            t["albumName"] = "Shared"
            t["albumArtist"] = "Shared artist"
    elif variant == "same-name-different-album-artist":
        for i, t in enumerate(tracks):
            t["albumName"] = "Shared"
            t["albumArtist"] = f"Artist {i}"
    else:
        raise AssertionError(variant)
    accepted(socket_client, "select-playlists", {"selectedPlaylistIds": ["A"], "tracks": tracks})


@then(parsers.parse('the contract retains {tracks:d} tracks and {albums:d} albums'))
def metadata_counts(socket_client, tracks, albums):
    assert len(socket_client.state["tracks"]) == tracks
    assert len(socket_client.state["albums"]) == albums
    assert len({t["id"] for t in socket_client.state["tracks"]}) == tracks
    accepted(socket_client, "start", {"quizMode": "intro"})
    assert len(socket_client.state["shuffledTrackIds"]) == tracks


@when("the contract replaces the next game selection")
def replace_selection(socket_client):
    accepted(socket_client, "next-game")
    accepted(socket_client, "select-playlists", {"selectedPlaylistIds": ["B"], "tracks": make_tracks(2, 50)})
    accepted(socket_client, "start", {"quizMode": "intro"})


@then("the contract only includes the new track IDs")
def only_new_selection(socket_client):
    assert set(socket_client.state["shuffledTrackIds"]) == {"track-50", "track-51"}
    assert {t["id"] for t in socket_client.state["tracks"]} == {"track-50", "track-51"}


@when(parsers.parse('the contract receives a stale "{notification}" from an earlier game'))
def stale_notification(socket_client, http, contract, notification):
    # Capture the actual operation token before reset, then deliver it when a
    # different game reaches the same step.
    delayed = "console:" + notification
    payload = {"operationId": socket_client.state["operationId"]}
    accepted(socket_client, "reset")
    state = "intro:playing" if notification == "play-ended" else "intro:" + notification.split("-")[0]
    contract_state(socket_client, http, contract, state)
    before = deepcopy(socket_client.state)
    socket_client.emit(delayed, payload)
    contract["before"] = before


@then("the stale notification leaves the new game untouched")
def stale_ignored(socket_client, contract):
    assert socket_client.state == contract["before"]
