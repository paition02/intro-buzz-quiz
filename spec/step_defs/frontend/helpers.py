"""Screen-level helpers shared by the frontend step definitions.

Every helper reads or drives what a host, player, or audience member can see
and touch: the console page, the gameboard page, the action page, and the
action API. Nothing here reads the server's state over the socket.
"""

from __future__ import annotations

import re

from playwright.sync_api import Page, expect

# Test data (musickit_mock.py): song "track-N" is titled "Track N" by "Artist N" on "Album N".
TRACK_TITLE = re.compile(r"^Track \d+$")
ARTIST_NAME = re.compile(r"^Artist \d+$")
ALBUM_NAME = re.compile(r"^Album \d+$")

STAGE_TIMEOUT_MS = 30000


def track_id_for_title(title: str) -> str:
    return "track-" + title.removeprefix("Track ")


def album_first_track_id(album_name: str) -> str:
    return "track-" + album_name.removeprefix("Album ")


def catalog_album_id(album_name: str) -> str:
    return "album-" + album_first_track_id(album_name)


def library_album_id_for(track_id: str) -> str:
    return "l." + "".join(ch for ch in "album" + track_id.removeprefix("i.") if ch.isalnum())


# --- console -----------------------------------------------------------------


def console_stage(console: Page):
    """The "現在" heading naming the phase or step the host sees."""
    return console.get_by_role("heading", level=2, name=re.compile(r"(フェーズ|ステップ|待機中)$"))


def expect_stage(console: Page, stage: str, timeout: int = STAGE_TIMEOUT_MS):
    expect(console.get_by_role("heading", level=2, name=stage, exact=True)).to_be_visible(timeout=timeout)


def expect_stage_in(console: Page, stages: list[str], timeout: int = STAGE_TIMEOUT_MS):
    expect(console.get_by_role("heading", level=2, name=re.compile("^(" + "|".join(map(re.escape, stages)) + ")$"))).to_be_visible(timeout=timeout)


def click(console: Page, label: str, timeout: int = 10000):
    console.get_by_role("button", name=label, exact=True).click(timeout=timeout)


def playback_seconds_slider(console: Page):
    return console.get_by_role("slider", name="再生秒数", exact=True)


def set_playback_seconds(console: Page, seconds: float):
    slider = playback_seconds_slider(console)
    slider.focus()
    current = float(slider.get_attribute("aria-valuenow") or "0.5")
    difference = round((seconds - current) * 10)
    for _ in range(abs(difference)):
        slider.press("ArrowRight" if difference > 0 else "ArrowLeft")
    expect(slider).to_have_attribute("aria-valuenow", f"{seconds:g}")


def play_button(console: Page):
    return console.get_by_role("button", name="再生", exact=True)


def play_intro(console: Page, seconds: float | None = None):
    if seconds is not None:
        set_playback_seconds(console, seconds)
    expect(play_button(console)).to_be_enabled(timeout=STAGE_TIMEOUT_MS)
    click(console, "再生")
    expect_stage(console, "再生中ステップ")


def round_info_region(console: Page):
    name = "アルバム情報" if console.get_by_role("region", name="アルバム情報", exact=True).count() else "曲情報"
    return console.get_by_role("region", name=name, exact=True)


def round_info_title(console: Page) -> str:
    """The title of the current round in the host's 曲情報 / アルバム情報.

    Opens the disclosure when it is closed and closes it again afterwards, so
    the host's view is left as it was.
    """
    region = round_info_region(console)
    opener = region.get_by_role("button", name=re.compile("を開く$"))
    expect(region.get_by_role("button", name=re.compile("を(開く|閉じる)$"))).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    was_closed = opener.count() > 0
    if was_closed:
        opener.click(timeout=10000)
    title_element = region.locator("strong")
    expect(title_element).to_be_visible(timeout=STAGE_TIMEOUT_MS)
    title = title_element.inner_text()
    if was_closed:
        region.get_by_role("button", name=re.compile("を閉じる$")).click(timeout=10000)
        expect(title_element).to_have_count(0, timeout=STAGE_TIMEOUT_MS)
    return title


def round_track_id(console: Page) -> str:
    return track_id_for_title(round_info_title(console))


def participant_badge(page: Page, actor: str):
    return page.get_by_label(actor, exact=True)


def expect_participant(page: Page, actor: str, timeout: int = STAGE_TIMEOUT_MS):
    expect(participant_badge(page, actor).first).to_be_visible(timeout=timeout)


def expect_no_participants(console: Page, timeout: int = STAGE_TIMEOUT_MS):
    expect(console.get_by_text("まだいません", exact=True)).to_be_visible(timeout=timeout)


def expect_some_participant(console: Page, timeout: int = STAGE_TIMEOUT_MS):
    expect(console.get_by_text("参加中:", exact=True)).to_be_visible(timeout=timeout)
    expect(console.get_by_text("まだいません", exact=True)).to_have_count(0, timeout=timeout)


def selection_summary(console: Page):
    return console.get_by_text(re.compile(r"^\d+件のプレイリスト、\d+曲を選択中$"))


def expect_selection(console: Page, playlists: int, tracks: int, timeout: int = STAGE_TIMEOUT_MS):
    expect(console.get_by_text(f"{playlists}件のプレイリスト、{tracks}曲を選択中", exact=True)).to_be_visible(timeout=timeout)


def expect_no_selection(console: Page, timeout: int = STAGE_TIMEOUT_MS):
    expect(selection_summary(console)).to_have_count(0, timeout=timeout)


# --- gameboard ---------------------------------------------------------------


def answering_glyph(board: Page, actor: str):
    """The large silhouette the gameboard shows for the player holding answer rights."""
    return board.get_by_role("img", name=actor, exact=True)


def expect_answerer(board: Page, actor: str, timeout: int = STAGE_TIMEOUT_MS):
    expect(board.get_by_role("heading", name="解答をどうぞ！", exact=True)).to_be_visible(timeout=timeout)
    expect(answering_glyph(board, actor)).to_be_visible(timeout=timeout)


def expect_no_answerer(board: Page, timeout: int = STAGE_TIMEOUT_MS):
    expect(board.get_by_role("heading", name="解答をどうぞ！", exact=True)).to_have_count(0, timeout=timeout)


def expect_score(board: Page, actor: str, score: int, timeout: int = STAGE_TIMEOUT_MS):
    """The score under a participant silhouette in the gameboard's player row."""
    expect(participant_badge(board, actor).last).to_have_text(str(score), timeout=timeout)


def results_score(board: Page, actor: str):
    """The large score next to a participant on the results view."""
    return participant_badge(board, actor).locator("xpath=ancestor::*[strong][1]").locator("strong")


def expect_results_score(board: Page, actor: str, score: int, timeout: int = STAGE_TIMEOUT_MS):
    expect(board.get_by_role("heading", name="結果発表！", exact=True)).to_be_visible(timeout=timeout)
    expect(results_score(board, actor)).to_have_text(str(score), timeout=timeout)
