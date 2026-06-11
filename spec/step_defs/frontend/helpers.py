from __future__ import annotations

from typing import Any

SAMPLE_PLAYLISTS = [
    {"id": "playlist-a", "name": "Spec Playlist A"},
    {"id": "playlist-b", "name": "Spec Playlist B"},
]


def sample_tracks(count: int = 3) -> list[dict[str, Any]]:
    return [
        {
            "id": f"track-{index}",
            "title": f"Track {index}",
            "artist": f"Artist {index}",
            "artworkChipUrl": f"https://example.test/artwork/{index}-chip.jpg",
            "artworkInfoUrl": f"https://example.test/artwork/{index}-info.jpg",
            "artworkRevealUrl": f"https://example.test/artwork/{index}-reveal.jpg",
        }
        for index in range(1, count + 1)
    ]
