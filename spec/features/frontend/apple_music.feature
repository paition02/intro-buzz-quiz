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

  Scenario: Selecting a playlist prepares a MusicKit queue with catalog song ids
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "Spec Playlist A"
    Then MusicKit queue is prepared with songs "track-1,track-2,track-3"
    And backend selected playlist ids are "playlist-a"

  Scenario: Starting a selected game loads the current track on MusicKit
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then backend phase is "game" and step is "beforePlayback"
    And MusicKit changes to the backend current track
    And MusicKit seeks to 0

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
