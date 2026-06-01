from __future__ import annotations

from typing import Any


def make_tracks(count: int, playlist: str = "Playlist A", offset: int = 1) -> list[dict[str, Any]]:
    return [
        {
            "id": f"track-{offset + index}",
            "title": f"Song {offset + index}",
            "artist": f"Artist {offset + index}",
            "playlist": playlist,
            "artworkUrl": f"https://example.test/artwork/{offset + index}.jpg",
            "artworkThumbUrl": f"https://example.test/artwork/{offset + index}-thumb.jpg",
        }
        for index in range(count)
    ]


def player(state: dict[str, Any], actor_id: str) -> dict[str, Any] | None:
    return next((p for p in state["players"] if p["id"] == actor_id), None)


def assert_player(state: dict[str, Any], actor_id: str) -> dict[str, Any]:
    found = player(state, actor_id)
    assert found is not None, f"player {actor_id!r} not found in {state['players']!r}"
    return found
