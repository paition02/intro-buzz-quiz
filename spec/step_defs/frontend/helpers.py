from __future__ import annotations

from typing import Any

SAMPLE_PLAYLISTS = [
    {"id": "playlist-a", "name": "Spec Playlist A"},
    {"id": "playlist-b", "name": "Spec Playlist B"},
]


def sample_tracks(count: int = 3, playlist: str = "Spec Playlist A") -> list[dict[str, Any]]:
    return [
        {
            "id": f"track-{index}",
            "title": f"Track {index}",
            "artist": f"Artist {index}",
            "playlist": playlist,
            "artworkUrl": f"https://example.test/artwork/{index}.jpg",
            "artworkThumbUrl": f"https://example.test/artwork/{index}-thumb.jpg",
        }
        for index in range(1, count + 1)
    ]
