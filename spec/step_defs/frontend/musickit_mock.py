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


def _playlist_name(playlist_id: str) -> str:
    if playlist_id == "playlist-a":
        return "Spec Playlist A"
    if playlist_id == "playlist-b":
        return "Spec Playlist B"
    return playlist_id


def _make_song(song_id: str, *, title: str | None = None) -> Song:
    base = _silence_song()
    n = song_id.removeprefix("track-") or song_id
    return Song(
        title=title or f"Track {n}",
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


def _make_playlist(playlist_id: str, track_ids: list[str], *, name: str | None = None) -> Playlist:
    return Playlist(
        name=name or _playlist_name(playlist_id),
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


def _make_library_song(song_id: str, *, name: str | None = None) -> LibrarySong:
    n = song_id.removeprefix("track-") or song_id
    return LibrarySong(
        name=name or f"Track {n}",
        artist_name=f"Artist {n}",
        artwork=Artwork(url=f"https://example.test/artwork/{n}/{{w}}x{{h}}.jpg", width=1000, height=1000),
        duration_ms=2000,
        genre_names=["Test"],
        has_lyrics=False,
        album_name="Test Album",
        catalog_id=song_id,
    )


def _make_library_playlist(
    playlist_id: str,
    track_ids: list[str] | None = None,
    *,
    name: str | None = None,
) -> LibraryPlaylist:
    return LibraryPlaylist(
        name=name or _playlist_name(playlist_id),
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


def _build_library_playlists_response(
    playlists: dict[str, LibraryPlaylist],
    *,
    limit: int,
    offset: int,
) -> dict[str, object]:
    page_entries = list(playlists.items())[offset : offset + limit]
    body: dict[str, object] = {
        "data": [
            {
                "id": playlist_id,
                "type": "library-playlists",
                "href": f"/v1/me/library/playlists/{playlist_id}",
                "attributes": {
                    "name": playlist.name,
                    "artwork": {
                        "url": playlist.artwork.url,
                        "width": playlist.artwork.width,
                        "height": playlist.artwork.height,
                    },
                },
            }
            for playlist_id, playlist in page_entries
        ]
    }
    next_offset = offset + limit
    if next_offset < len(playlists):
        body["next"] = f"/v1/me/library/playlists?offset={next_offset}&limit={limit}"
    return body


def _configure_library_data(
    mock: MusicKitApiMock,
    playlist_tracks: dict[str, list[str]],
    *,
    playlist_names: dict[str, str] | None = None,
    song_titles: dict[str, str] | None = None,
    playback_error: bool = False,
) -> None:
    playlist_names = playlist_names or {}
    song_titles = song_titles or {}
    song_ids = list(dict.fromkeys(song_id for track_ids in playlist_tracks.values() for song_id in track_ids))

    mock.data.songs = {
        song_id: _make_song(song_id, title=song_titles.get(song_id))
        for song_id in song_ids
    }
    mock.data.library_songs = {
        song_id: _make_library_song(song_id, name=song_titles.get(song_id))
        for song_id in song_ids
    }
    mock.data.library_playlists = {
        playlist_id: _make_library_playlist(
            playlist_id,
            track_ids,
            name=playlist_names.get(playlist_id),
        )
        for playlist_id, track_ids in playlist_tracks.items()
    }

    def resolve_playlist(ctx: LookupContext) -> Playlist | None:
        if ctx.id not in playlist_tracks:
            return None
        return _make_playlist(
            ctx.id,
            playlist_tracks[ctx.id],
            name=playlist_names.get(ctx.id),
        )

    playlist_callable: Callable[[LookupContext], Playlist | None] = resolve_playlist
    mock.data.playlists = playlist_callable
    mock.endpoints.web_playback = _build_web_playback(song_ids, error=playback_error)


def set_musickit_library_data(
    page: Page,
    playlist_tracks: dict[str, list[str]],
    *,
    playlist_names: dict[str, str] | None = None,
    song_titles: dict[str, str] | None = None,
) -> None:
    mock = getattr(page, "music_kit_api_mock", None)
    if mock is None:
        raise AssertionError("MusicKit API mock has not been configured for this page")
    _configure_library_data(
        mock,
        playlist_tracks,
        playlist_names=playlist_names,
        song_titles=song_titles,
    )


def _parse_positive_int(values: list[str] | None, *, default: int) -> int:
    if not values:
        return default
    try:
        value = int(values[0])
    except ValueError:
        return default
    return value if value > 0 else default


def _parse_non_negative_int(values: list[str] | None, *, default: int) -> int:
    if not values:
        return default
    try:
        value = int(values[0])
    except ValueError:
        return default
    return value if value >= 0 else default


def _register_library_playlists_override(page: Page, mock: MusicKitApiMock) -> None:
    def handler(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path != "/v1/me/library/playlists":
            route.fallback()
            return
        if route.request.method == "OPTIONS":
            route.fulfill(status=204, headers=_CORS_PREFLIGHT_HEADERS)
            return
        query = parse_qs(parsed.query)
        limit = min(_parse_positive_int(query.get("limit"), default=100), 100)
        offset = _parse_non_negative_int(query.get("offset"), default=0)
        playlists = mock.data.library_playlists
        if not isinstance(playlists, dict):
            raise AssertionError("mock.data.library_playlists must be a dict for playlist list responses")
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(_build_library_playlists_response(playlists, limit=limit, offset=offset)),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    page.route("**/api.music.apple.com/v1/me/library/playlists*", handler)


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
    _configure_library_data(
        mock,
        {
            playlist_id: song_ids[3:5] if playlist_id == "playlist-b" else song_ids[:3]
            for playlist_id in library_ids
        },
        playback_error=playback_error,
    )

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
    _register_library_playlists_override(page, mock)
    setattr(page, "music_kit_api_mock", mock)
    return mock
