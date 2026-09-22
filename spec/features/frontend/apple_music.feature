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
    And the frontend clicks "ログイン"
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
    And the frontend clicks "イントロで開始"
    Then the selected round artwork URLs are sized for their display contexts
    And the selected tracks include album names

  Scenario: Library playlist tracks of one album across two library albums form one jacket album
    Given the frontend console is logged into mocked MusicKit with playlist "Spec Playlist A" on two library albums of one album
    When the frontend clicks "Spec Playlist A"
    Then MusicKit tracks for library playlist "playlist-a" are requested with their library albums
    And the selected track count is 3
    And the selected tracks carry album artist "Shared Artist"
    And the selected album count is 1

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
    When the frontend clicks "イントロで開始"
    Then backend phase is "game" and step is "beforePlayback"
    And backend quiz mode is "intro"
    And the frontend play button becomes enabled

  Scenario: Starting jacket mode shows jacket controls
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ジャケットで開始"
    Then backend phase is "game" and step is "beforePlayback"
    And backend quiz mode is "jacket"
    And the frontend shows jacket controls
    And the frontend does not show "再生"

  Scenario: Jacket controls update backend settings
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ジャケットで開始"
    And the frontend selects jacket mode "tileShuffle"
    And the frontend toggles jacket grayscale
    And the frontend sets jacket hint percent to 12
    Then the backend jacket settings match the frontend controls

  Scenario: Play is available when the current round is ready
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    Then the frontend play button becomes enabled

  Scenario: Playing the intro advances playback and stops after the duration
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    And the frontend clicks "再生"
    Then backend phase is "game" and step is "playing"
    And the backend returns before playback after the intro duration

  Scenario: Revealing a round shows the current track
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
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
    And the frontend clicks "ログイン"
    Then the frontend shows "Library unavailable"

  Scenario: Playlist track loading failure is shown on the console
    Given the frontend console is logged into mocked MusicKit with track loading failure "Tracks unavailable"
    When the frontend opens playlist "Spec Playlist A"
    Then the frontend shows "Tracks unavailable"


  Scenario: Jacket hint repeated keys and new round stay synchronized
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ジャケットで開始"
    And the frontend sets jacket hint percent to 47
    Then the jacket hint slider shows 47 percent
    When the frontend sets jacket hint percent to 12
    Then the jacket hint slider shows 12 percent
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the jacket hint slider shows 1 percent
    When the frontend sets jacket hint percent to 12
    Then the jacket hint slider shows 12 percent


  Scenario: Host album information follows the current jacket round
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ジャケットで開始"
    Then the album information is collapsed
    When the frontend clicks "アルバム情報を開く"
    Then the album information matches the current backend album
    When the frontend clicks "アルバム情報を閉じる"
    Then the album information is collapsed
    When the frontend clicks "アルバム情報を開く"
    And the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the album information is collapsed
    When the frontend clicks "アルバム情報を開く"
    Then the album information matches the current backend album


  Scenario: Jacket reveal uses a complete MusicKit album queue
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "ジャケットで開始"
    And album queue requests are observed
    And the frontend clicks "ギブアップ"
    Then MusicKit plays the entire revealed album with repeat all
    When the frontend clicks "次のラウンドへ"
    Then album playback is stopped
    When the frontend clicks "ギブアップ"
    Then MusicKit plays the entire revealed album with repeat all
    When the frontend clicks "結果発表へ"
    Then album playback is stopped


  Scenario: Jacket reveal plays the library album for library song IDs
    Given the frontend console selected playlist "Spec Playlist A"
    And the selected tracks have library IDs
    When the frontend clicks "ジャケットで開始"
    And album queue requests are observed
    And the frontend clicks "ギブアップ"
    Then MusicKit plays the entire revealed library album with repeat all
    And no catalog lookup is sent for library song IDs

  Scenario: Intro rounds keep preparing when the host advances quickly
    Given the frontend console selected mocked playlist "Spec Long" containing 4 tracks
    When the frontend clicks "イントロで開始"
    Then the frontend play button becomes enabled
    When the frontend clicks "再生"
    Then the backend returns before playback after the intro duration
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the frontend play button becomes enabled
    And MusicKit has loaded the backend round track
    When the frontend clicks "再生"
    Then the backend returns before playback after the intro duration
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the frontend play button becomes enabled
    And MusicKit has loaded the backend round track

  Scenario: Advancing right after the reveal does not start the revealed track later
    Given the frontend console selected mocked playlist "Spec Long" containing 4 tracks
    And MusicKit playback is observed
    When the frontend clicks "イントロで開始"
    Then the frontend play button becomes enabled
    When the frontend clicks "再生"
    Then the backend returns before playback after the intro duration
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the frontend play button becomes enabled
    And MusicKit does not start the previous round track after advancing

  Scenario: The next round track is preloaded and loads without fetching its manifest
    Given the frontend console selected mocked playlist "Spec Long" containing 4 tracks
    And MusicKit playback is observed
    When the frontend clicks "イントロで開始"
    Then the frontend play button becomes enabled
    And MusicKit has queued the next backend round track
    And MusicKit has fetched the manifest of the next backend round track
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the frontend play button becomes enabled
    And MusicKit has loaded the backend round track
    And MusicKit has not fetched the manifest of the backend round track since advancing

  Scenario: The intro reveal loops the round track without advancing the queue
    Given the frontend console selected mocked playlist "Spec Long" containing 4 tracks
    When the frontend clicks "イントロで開始"
    Then the frontend play button becomes enabled
    When the frontend clicks "ギブアップ"
    Then MusicKit is playing the backend round track
    And MusicKit is still playing the backend round track after the track duration
