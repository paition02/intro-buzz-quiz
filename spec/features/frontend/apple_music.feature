Feature: MusicKit integration
  As a host
  I want the console to use MusicKit for authorization, playlist loading, queueing, and playback
  So that the game uses real Apple Music behavior through one integration boundary

  Scenario: MusicKit SDK is initialized with the developer token from the server
    When the frontend opens "/console" with mocked MusicKit
    Then MusicKit is configured with the developer token from the server
    And the frontend shows "Apple Music 未ログイン"

  Scenario: Already authorized MusicKit loads library playlists
    Given MusicKit is already authorized
    When the frontend opens "/console" with mocked MusicKit
    Then the frontend shows "Apple Music ログイン済み"
    And MusicKit library playlists are requested
    And the frontend shows "Spec Playlist A"

  Scenario: Library playlist pagination is followed
    Given mocked MusicKit has paginated library playlists
    And MusicKit is already authorized
    When the frontend opens "/console" with mocked MusicKit
    Then MusicKit library playlists page 1 is requested
    And MusicKit library playlists page 2 is requested
    And the frontend shows "Spec Playlist A"
    And the frontend shows "Spec Playlist Page 2"

  Scenario: Authorizing MusicKit loads the library playlists
    When the frontend opens "/console" with mocked MusicKit
    And the frontend clicks "Apple Musicにログイン"
    Then MusicKit authorization is requested
    And MusicKit library playlists are requested
    And the frontend shows "Spec Playlist A"

  Scenario: Opening a library playlist loads tracks with catalog ids and artwork
    Given the frontend console is logged into mocked MusicKit
    When the frontend opens playlist "Spec Playlist A"
    Then MusicKit tracks for library playlist "playlist-a" are requested
    And the frontend shows "Track 1"

  Scenario: Library playlist track pagination is followed
    Given the frontend console is logged into mocked MusicKit with paginated tracks for playlist "Spec Playlist A"
    When the frontend opens playlist "Spec Playlist A"
    Then MusicKit tracks page 1 for library playlist "playlist-a" is requested
    And MusicKit tracks page 2 for library playlist "playlist-a" is requested
    And the frontend shows "Track 1"
    And the frontend shows "Track Page 2"

  Scenario: Library playlist tracks expose full-size artwork and thumbnails
    Given the frontend console is logged into mocked MusicKit
    When the frontend opens playlist "Spec Playlist A"
    Then the frontend shows artwork thumbnail URL "https://example.test/artwork/1/80x80.jpg"
    When the frontend clicks "Spec Playlist A"
    And the frontend clicks "ゲーム開始"
    Then backend current track artwork URL uses size "1000x1000"
    And backend current track artwork thumbnail URL uses size "80x80"

  Scenario: Selecting a playlist prepares a MusicKit queue with catalog song ids
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "Spec Playlist A"
    Then MusicKit queue is prepared with songs "track-1,track-2,track-3"
    And backend selected playlist ids are "playlist-a"

  Scenario: Preparing more than 50 tracks queues the first MusicKit chunk
    Given the frontend console is logged into mocked MusicKit with playlist "Spec Long Playlist" containing 55 tracks
    When the frontend clicks "Spec Long Playlist"
    Then MusicKit queue is prepared with the first 50 songs from "track-1" to "track-50"
    And backend selected playlist ids are "playlist-long"

  Scenario: Loading a track outside the first MusicKit chunk replaces the queue
    Given the frontend console selected mocked playlist "Spec Long Playlist" containing 55 tracks
    And the backend current track is "track-55"
    When the frontend loads the backend current track
    Then MusicKit queue is prepared with songs "track-51,track-52,track-53,track-54,track-55"
    And MusicKit changes to queue index 4

  Scenario: Starting a selected game loads the current track on MusicKit
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then backend phase is "game" and step is "beforePlayback"
    And MusicKit changes to the backend current track
    And MusicKit seeks to 0

  Scenario: Loading the current track stops MusicKit autoplay
    Given MusicKit auto-starts after seeking while loading
    And the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then backend phase is "game" and step is "beforePlayback"
    And MusicKit pauses the loading autoplay

  Scenario: Play is locked until the current MusicKit track finishes loading
    Given MusicKit current track loading is delayed
    And the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then the frontend play button shows "ロード中" and is disabled
    And MusicKit has not started playback
    And the frontend play button becomes enabled

  Scenario: Playing the intro uses MusicKit playback and stops after the duration
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    And the frontend clicks "再生"
    Then MusicKit starts playback
    And MusicKit pauses playback after the intro duration
    And MusicKit seeks to 0 after playback

  Scenario: Revealing a round plays the current track in full loop
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    And the frontend clicks "ギブアップ"
    Then MusicKit repeat mode is one
    And MusicKit starts playback

  Scenario: Logging out of Apple Music returns the console to the unauthenticated state
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "ログアウト"
    Then MusicKit unauthorization is requested
    And the frontend shows "Apple Music 未ログイン"

  Scenario: MusicKit configuration failure is shown on the console
    Given mocked MusicKit configuration fails with "Token request failed"
    When the frontend opens "/console" with mocked MusicKit
    Then the frontend shows "Token request failed"

  Scenario: Library playlist loading failure is shown on the console
    Given mocked MusicKit library playlist loading fails with "Library unavailable"
    When the frontend opens "/console" with mocked MusicKit
    And the frontend clicks "Apple Musicにログイン"
    Then the frontend shows "Library unavailable"

  Scenario: Playlist track loading failure is shown on the console
    Given the frontend console is logged into mocked MusicKit with track loading failure "Tracks unavailable"
    When the frontend opens playlist "Spec Playlist A"
    Then the frontend shows "Tracks unavailable"
