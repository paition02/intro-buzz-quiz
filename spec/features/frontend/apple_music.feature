Feature: MusicKit integration
  As a host
  I want the console to use MusicKit for authorization, playlist loading, and game controls
  So that the game uses real Apple Music behavior through one integration boundary

  Scenario: MusicKit SDK is initialized with the developer token from the server
    When the frontend opens "/console" with mocked MusicKit
    Then the MusicKit developer token is requested
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
    Then the frontend shows "Apple Music ログイン済み"
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

  Scenario: Library playlist tracks expose purpose-sized artwork
    Given the frontend console is logged into mocked MusicKit
    When the frontend opens playlist "Spec Playlist A"
    Then the frontend shows track chip artwork
    When the frontend clicks "Spec Playlist A"
    And the frontend clicks "ゲーム開始"
    Then the selected round artwork URLs are sized for their display contexts

  Scenario: Selecting a playlist sends the selected tracks to the backend
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "Spec Playlist A"
    Then backend selected playlist ids are "playlist-a"
    And the selected track count is 3

  Scenario: Selecting more than 50 tracks sends the selected tracks to the backend
    Given the frontend console is logged into mocked MusicKit with playlist "Spec Long Playlist" containing 55 tracks
    When the frontend clicks "Spec Long Playlist"
    Then backend selected playlist ids are "playlist-long"
    And the selected track count is 55

  Scenario: Starting a selected game prepares the first round without playback
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then backend phase is "game" and step is "beforePlayback"
    And the frontend play button becomes enabled

  Scenario: Play is available when the current round is ready
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    Then the frontend play button becomes enabled

  Scenario: Playing the intro advances playback and stops after the duration
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    And the frontend clicks "再生"
    Then backend phase is "game" and step is "playing"
    And the backend returns before playback after the intro duration

  Scenario: Revealing a round shows the current track
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ゲーム開始"
    And the frontend clicks "ギブアップ"
    Then backend phase is "game" and step is "reveal"
    When the frontend clicks "曲情報を開く"
    Then the frontend shows revealed track information

  Scenario: Logging out of Apple Music returns the console to the unauthenticated state
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "ログアウト"
    Then the frontend shows "Apple Music 未ログイン"

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
