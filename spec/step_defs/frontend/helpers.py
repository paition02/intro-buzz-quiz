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


def musickit_mock_script() -> str:
    return """
(() => {
  const playlists = [
    { id: 'playlist-a', attributes: { name: 'Spec Playlist A' } },
    { id: 'playlist-b', attributes: { name: 'Spec Playlist B' } },
  ];
  const tracksByPlaylist = {
    'playlist-a': [1, 2, 3].map((index) => ({
      id: `library-track-${index}`,
      attributes: {
        name: `Track ${index}`,
        artistName: `Artist ${index}`,
        artwork: { url: `https://example.test/artwork/${index}/{w}x{h}.jpg` },
      },
      relationships: {
        catalog: { data: [{ id: `track-${index}`, attributes: {
          name: `Track ${index}`,
          artistName: `Artist ${index}`,
          artwork: { url: `https://example.test/artwork/${index}/{w}x{h}.jpg` },
        }}] },
      },
    })),
    'playlist-b': [4, 5].map((index) => ({
      id: `library-track-${index}`,
      attributes: { name: `Track ${index}`, artistName: `Artist ${index}` },
      relationships: { catalog: { data: [{ id: `track-${index}`, attributes: { name: `Track ${index}`, artistName: `Artist ${index}` } }] } },
    })),
  };
  let authorized = false;
  const listeners = new Set();
  const mk = {
    get isAuthorized() { return authorized; },
    isPlaying: false,
    nowPlayingItemIndex: 0,
    repeatMode: 0,
    shuffleMode: 0,
    addEventListener: (_name, handler) => listeners.add(handler),
    removeEventListener: (_name, handler) => listeners.delete(handler),
    authorize: async () => { authorized = true; listeners.forEach((handler) => handler()); },
    unauthorize: async () => { authorized = false; listeners.forEach((handler) => handler()); },
    setQueue: async () => {},
    changeToMediaAtIndex: async (index) => { mk.nowPlayingItemIndex = index; },
    seekToTime: async () => {},
    play: async () => { mk.isPlaying = true; },
    pause: () => { mk.isPlaying = false; },
    api: { music: async (url) => {
      if (url === '/v1/me/library/playlists') return { data: { data: playlists } };
      const match = url.match(/\/v1\/me\/library\/playlists\/([^/]+)\/tracks/);
      if (match) return { data: { data: tracksByPlaylist[match[1]] ?? [] } };
      return { data: { data: [] } };
    } },
  };
  window.MusicKit = {
    PlayerShuffleMode: { off: 0 },
    PlayerRepeatMode: { one: 1 },
    configure: () => mk,
  };
  window.dispatchEvent(new Event('musickitloaded'));
  document.dispatchEvent(new Event('musickitloaded'));
})();
"""
