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
    return r"""
(() => {
  const calls = [];
  const record = (name, payload = {}) => calls.push({ name, payload, at: Date.now() });
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
  let authorized = Boolean(window.__musicKitMockOptions?.authorized);
  const listeners = new Set();
  const notifyAuthorization = () => listeners.forEach((handler) => handler());
  const mk = {
    get isAuthorized() { return authorized; },
    isPlaying: false,
    nowPlayingItemIndex: 0,
    repeatMode: 0,
    shuffleMode: 0,
    addEventListener: (name, handler) => { record('addEventListener', { name }); listeners.add(handler); },
    removeEventListener: (name, handler) => { record('removeEventListener', { name }); listeners.delete(handler); },
    authorize: async () => { record('authorize'); authorized = true; notifyAuthorization(); },
    unauthorize: async () => { record('unauthorize'); authorized = false; notifyAuthorization(); },
    setQueue: async (payload) => { record('setQueue', payload); },
    changeToMediaAtIndex: async (index) => { record('changeToMediaAtIndex', { index }); mk.nowPlayingItemIndex = index; },
    seekToTime: async (time) => { record('seekToTime', { time }); },
    play: async () => { record('play'); mk.isPlaying = true; },
    pause: () => { record('pause'); mk.isPlaying = false; },
    api: { music: async (url, params) => {
      record('api.music', { url, params });
      if (url === '/v1/me/library/playlists') return { data: { data: playlists } };
      const match = url.match(/\/v1\/me\/library\/playlists\/([^/]+)\/tracks/);
      if (match) return { data: { data: tracksByPlaylist[match[1]] ?? [] } };
      return { data: { data: [] } };
    } },
  };
  window.__musicKitMock = {
    calls,
    instance: mk,
    setAuthorized(value) { authorized = value; notifyAuthorization(); },
  };
  window.MusicKit = {
    PlayerShuffleMode: { off: 0 },
    PlayerRepeatMode: { one: 1 },
    configure: (config) => { record('configure', config); return mk; },
  };
  window.dispatchEvent(new Event('musickitloaded'));
  document.dispatchEvent(new Event('musickitloaded'));
})();
"""
