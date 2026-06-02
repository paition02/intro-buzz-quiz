"""MusicKit API mock wiring for frontend BDD tests.

This follows ateruta's approach: serve the real MusicKit JS and route its
Apple Music network traffic through ``musickit-api-mock-playwright`` instead
of replacing ``window.MusicKit`` with a hand-written stub.
"""

from __future__ import annotations

import base64
import json
import tempfile
import time
import urllib.request
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from musickit_api_mock import (
    Account,
    AccountResponseFailure,
    AccountResponseSuccess,
    Artwork,
    AuthorizeSuccess,
    LibraryPlaylist,
    LibrarySong,
    LicenseResponseSuccess,
    LogoutResponseSuccess,
    LookupContext,
    MusicKitApiMock,
    PlayActivityResponseSuccess,
    Playlist,
    Song,
    SongMetadataFallback,
    Storefront,
    StorefrontResponseFailure,
    StorefrontResponseSuccess,
    WebPlaybackAsset,
    WebPlaybackResponse,
    WebPlaybackResponseServerError,
    WebPlaybackResponseSuccess,
    WebPlaybackSong,
    WidevineCertResponseSuccess,
)
from musickit_api_mock_playwright import intercept
from playwright.sync_api import Page, Route

_DEVELOPER_TEAM_ID = "test-team"
SAMPLE_CATALOG_SONGS = [f"track-{index}" for index in range(1, 11)]
DEFAULT_LIBRARY_PLAYLIST_IDS = ["playlist-a", "playlist-b"]
_MUSICKIT_JS_GLOB = "**/musickit/v3/musickit.js"
_MUSICKIT_SCRIPT_HOST = "js-cdn.music.apple.com"
_MUSICKIT_NETWORK_HOSTS = frozenset(
    {
        "api.music.apple.com",
        "play.itunes.apple.com",
        "aod-ssl.itunes.apple.com",
        "s.mzstatic.com",
    }
)
_CORS_PREFLIGHT_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
}
_musickit_js_cache: dict[str, bytes] = {}
_silence_song_cache: Song | None = None


def make_developer_token(*, expired: bool = False) -> str:
    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = b64url(json.dumps({"alg": "ES256", "kid": "test"}).encode())
    now = int(time.time())
    exp = now - 86400 if expired else now + 86400
    payload = b64url(json.dumps({"iss": _DEVELOPER_TEAM_ID, "iat": now, "exp": exp}).encode())
    signature = b64url(b"\x00" * 64)
    return f"{header}.{payload}.{signature}"


def _build_silence_audio(out_path: Path, *, duration_sec: float = 2.0) -> None:
    import av
    from av.audio.frame import AudioFrame

    sample_rate = 44100
    container = av.open(str(out_path), "w", format="mp4")
    audio = container.add_stream("aac", rate=sample_rate)
    audio.layout = "mono"
    samples_per_frame = 1024
    total = int(duration_sec * sample_rate)
    silence_full = bytes(samples_per_frame * 4)
    pts = 0
    while pts < total:
        n = min(samples_per_frame, total - pts)
        frame = AudioFrame(format="fltp", layout="mono", samples=n)
        frame.sample_rate = sample_rate
        frame.planes[0].update(silence_full if n == samples_per_frame else bytes(n * 4))
        frame.pts = pts
        for pkt in audio.encode(frame):
            container.mux(pkt)
        pts += n
    for pkt in audio.encode(None):
        container.mux(pkt)
    container.close()


def _silence_song() -> Song:
    global _silence_song_cache
    if _silence_song_cache is None:
        path = Path(tempfile.gettempdir()) / "intro_buzz_musickit_silence.m4a"
        if not path.exists():
            _build_silence_audio(path)
        fallback = SongMetadataFallback(
            artwork=Artwork(url="https://example.test/artwork.jpg", width=64, height=64),
            has_lyrics=False,
            audio_locale="en-US",
            audio_traits=["lossless"],
            has_time_synced_lyrics=False,
            is_apple_digital_master=False,
            is_mastered_for_itunes=False,
            is_vocal_attenuation_allowed=False,
            url="https://music.apple.com/us/song/placeholder",
            title="Silence",
            artist="Test Artist",
            album="Test Album",
            genres=["Test"],
            release_date="2020-01-01",
            track_number=1,
            disc_number=1,
        )
        _silence_song_cache = Song.from_file(str(path), fallback)
    return _silence_song_cache


def _make_song(song_id: str) -> Song:
    base = _silence_song()
    n = song_id.removeprefix("track-") or song_id
    return Song(
        title=f"Track {n}",
        artist=f"Artist {n}",
        album=base.album,
        duration_ms=base.duration_ms,
        artwork=Artwork(url=f"https://example.test/artwork/{n}/{{w}}x{{h}}.jpg", width=1000, height=1000),
        genres=list(base.genres),
        has_lyrics=base.has_lyrics,
        audio_locale=base.audio_locale,
        audio_traits=list(base.audio_traits),
        has_time_synced_lyrics=base.has_time_synced_lyrics,
        is_apple_digital_master=base.is_apple_digital_master,
        is_mastered_for_itunes=base.is_mastered_for_itunes,
        is_vocal_attenuation_allowed=base.is_vocal_attenuation_allowed,
        url=f"https://music.apple.com/us/song/{song_id}",
        hls_layout=base.hls_layout,
        hls_segment=base.hls_segment,
        preview_audio=base.preview_audio,
        bitrate=base.bitrate,
        sample_rate=base.sample_rate,
        file_size=base.file_size,
        release_date=base.release_date,
        track_number=base.track_number,
        disc_number=base.disc_number,
    )


def _make_playlist(playlist_id: str, track_ids: list[str]) -> Playlist:
    return Playlist(
        name="Spec Playlist A" if playlist_id == "playlist-a" else "Spec Playlist B",
        playlist_type="editorial",
        curator_name="Apple Music",
        has_collaboration=False,
        is_chart=False,
        audio_traits=[],
        supports_sing=False,
        url=f"https://music.apple.com/us/playlist/x/{playlist_id}",
        artwork=Artwork(url="https://example.test/playlist.jpg", width=200, height=200),
        track_ids=track_ids,
    )


def _make_library_song(song_id: str) -> LibrarySong:
    n = song_id.removeprefix("track-") or song_id
    return LibrarySong(
        name=f"Track {n}",
        artist_name=f"Artist {n}",
        artwork=Artwork(url=f"https://example.test/artwork/{n}/{{w}}x{{h}}.jpg", width=1000, height=1000),
        duration_ms=2000,
        genre_names=["Test"],
        has_lyrics=False,
        album_name="Test Album",
        catalog_id=song_id,
    )


def _make_library_playlist(playlist_id: str, track_ids: list[str] | None = None) -> LibraryPlaylist:
    return LibraryPlaylist(
        name="Spec Playlist A" if playlist_id == "playlist-a" else "Spec Playlist B",
        can_delete=True,
        can_edit=True,
        is_public=False,
        has_catalog=False,
        has_collaboration=False,
        track_ids=list(track_ids or []),
        artwork=Artwork(url="https://example.test/library.jpg", width=200, height=200),
    )


def _build_web_playback(song_ids: Iterable[str], *, error: bool) -> dict[str, WebPlaybackResponse]:
    if error:
        return {song_id: WebPlaybackResponseServerError() for song_id in song_ids}
    return {
        song_id: WebPlaybackResponseSuccess(
            song_list=[
                WebPlaybackSong(
                    song_id=song_id,
                    hls_key_cert_url="https://s.mzstatic.com/skdtool_2021_certbundle.bin",
                    hls_key_server_url="https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense",
                    widevine_cert_url="https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/widevineCert",
                    assets=[
                        WebPlaybackAsset(
                            flavor="30:ctrp256",
                            url=f"https://aod-ssl.itunes.apple.com/itunes-assets/{song_id}/index.m3u8",
                        )
                    ],
                )
            ]
        )
        for song_id in song_ids
    }


def _build_library_playlists_response(playlist_ids: list[str]) -> dict[str, object]:
    return {
        "data": [
            {
                "id": pid,
                "type": "library-playlists",
                "href": f"/v1/me/library/playlists/{pid}",
                "attributes": {
                    "name": "Spec Playlist A" if pid == "playlist-a" else "Spec Playlist B",
                    "artwork": {"url": "https://example.test/library.jpg", "width": 200, "height": 200},
                },
            }
            for pid in playlist_ids
        ]
    }


def _build_catalog_songs_response(song_ids: list[str]) -> dict[str, object]:
    return {
        "data": [
            {
                "id": song_id,
                "type": "songs",
                "href": f"/v1/catalog/us/songs/{song_id}",
                "attributes": {
                    "name": f"Track {song_id.removeprefix('track-') or song_id}",
                    "artistName": f"Artist {song_id.removeprefix('track-') or song_id}",
                    "albumName": "Test Album",
                    "durationInMillis": 2000,
                    "genreNames": ["Test"],
                    "url": f"https://music.apple.com/us/song/{song_id}",
                    "artwork": {
                        "url": f"https://example.test/artwork/{song_id.removeprefix('track-') or song_id}/{{w}}x{{h}}.jpg",
                        "width": 1000,
                        "height": 1000,
                    },
                    "playParams": {"id": song_id, "kind": "song"},
                },
            }
            for song_id in song_ids
        ]
    }


def _register_library_playlists_override(page: Page, *, library_ids: list[str]) -> None:
    def handler(route: Route) -> None:
        if urlparse(route.request.url).path != "/v1/me/library/playlists":
            route.fallback()
            return
        if route.request.method == "OPTIONS":
            route.fulfill(status=204, headers=_CORS_PREFLIGHT_HEADERS)
            return
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(_build_library_playlists_response(library_ids)),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    page.route("**/api.music.apple.com/v1/me/library/playlists*", handler)


def _register_catalog_songs_override(page: Page) -> None:
    def handler(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if not parsed.path.endswith("/songs") or "/v1/catalog/" not in parsed.path:
            route.fallback()
            return
        if route.request.method == "OPTIONS":
            route.fulfill(status=204, headers=_CORS_PREFLIGHT_HEADERS)
            return
        song_ids = parse_qs(parsed.query).get("ids", [])
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(_build_catalog_songs_response(song_ids)),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    page.route("**/api.music.apple.com/v1/catalog/*/songs*", handler)


def _serve_musickit_js(page: Page) -> None:
    def handler(route: Route) -> None:
        if "body" not in _musickit_js_cache:
            with urllib.request.urlopen(route.request.url, timeout=20) as response:
                _musickit_js_cache["body"] = response.read()
        route.fulfill(status=200, content_type="application/javascript", body=_musickit_js_cache["body"])

    page.route(_MUSICKIT_JS_GLOB, handler)


def _is_musickit_js_request(url: str) -> bool:
    parsed = urlparse(url)
    return (parsed.hostname or "").lower() == _MUSICKIT_SCRIPT_HOST and parsed.path.endswith("/musickit.js")


def _is_musickit_network_request(url: str) -> bool:
    if _is_musickit_js_request(url):
        return False
    return (urlparse(url).hostname or "").lower() in _MUSICKIT_NETWORK_HOSTS


def _block_unmocked_musickit_requests(page: Page) -> None:
    def handler(route: Route) -> None:
        if _is_musickit_network_request(route.request.url):
            route.abort()
            return
        route.fallback()

    page.route("**/*", handler)


def configure_musickit_api_mock(
    page: Page,
    *,
    authorized: bool = False,
    songs: Iterable[str] | None = None,
    library_playlist_ids: Iterable[str] | None = None,
    playback_error: bool = False,
) -> MusicKitApiMock:
    song_ids = list(songs) if songs is not None else SAMPLE_CATALOG_SONGS[:5]
    library_ids = list(library_playlist_ids) if library_playlist_ids is not None else DEFAULT_LIBRARY_PLAYLIST_IDS

    mock = MusicKitApiMock()
    mock.data.songs = {song_id: _make_song(song_id) for song_id in song_ids}
    mock.data.library_songs = {song_id: _make_library_song(song_id) for song_id in song_ids}
    mock.data.library_playlists = {
        pid: _make_library_playlist(pid, song_ids[3:5] if pid == "playlist-b" else song_ids[:3])
        for pid in library_ids
    }

    def resolve_playlist(ctx: LookupContext) -> Playlist | None:
        if ctx.id == "playlist-b":
            return _make_playlist(ctx.id, track_ids=song_ids[3:5])
        return _make_playlist(ctx.id, track_ids=song_ids[:3])

    playlist_callable: Callable[[LookupContext], Playlist | None] = resolve_playlist
    mock.data.playlists = playlist_callable

    mock.endpoints.storefront = StorefrontResponseSuccess(
        storefront=Storefront(
            id="us",
            name="United States",
            default_language_tag="en-US",
            supported_language_tags=["en-US"],
            explicit_content_policy="allowed",
        )
    )
    mock.endpoints.account = AccountResponseSuccess(
        account=Account(subscription_active=True, subscription_storefront="us")
    )

    mock.endpoints.web_playback = _build_web_playback(song_ids, error=playback_error)
    mock.endpoints.widevine_cert = WidevineCertResponseSuccess(cert=b"")
    mock.endpoints.license_catalog_song = LicenseResponseSuccess(license=b"")
    mock.endpoints.play_activity = PlayActivityResponseSuccess()
    mock.endpoints.webplayer_logout = LogoutResponseSuccess()
    mock.browser.eme_flavor = "com.widevine.alpha"
    mock.browser.authorize_response = AuthorizeSuccess(user_token="fake-music-user-token", cid="cid", restricted=0)

    if authorized:
        page.add_init_script(
            f"""(() => {{
                const ns = "music.{_DEVELOPER_TEAM_ID}";
                localStorage.setItem(ns + ".media-user-token", "fake-music-user-token");
                localStorage.setItem(ns + ".itua", "us");
                localStorage.setItem(ns + ".pldfltcid", "cid");
                localStorage.setItem(ns + ".itre", "0");
            }})();"""
        )

    _serve_musickit_js(page)
    _block_unmocked_musickit_requests(page)
    intercept(mock, page)
    _register_library_playlists_override(page, library_ids=library_ids)
    _register_catalog_songs_override(page)
    return mock
