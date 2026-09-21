Feature: Host console page
  The console uses MusicKit, playlist selection, and server-synchronized game controls.

  Scenario: Console login loads library playlists through MusicKit
    When the frontend opens "/console" with mocked MusicKit
    Then the document title is "ホストコンソール | 早押しイントロクイズ"
    And the frontend shows "Apple Music 未ログイン"
    When the frontend clicks "ログイン"
    Then the frontend shows "Apple Music ログイン済み"
    And the frontend shows "Spec Playlist A"
    And the frontend shows "Spec Playlist B"

  Scenario: Console can expand and select a playlist
    Given the frontend console is logged into mocked MusicKit
    When the frontend opens playlist "Spec Playlist A"
    Then the frontend shows "Track 1"
    When the frontend clicks "Spec Playlist A"
    Then the frontend shows "1件のプレイリスト、3曲を選択中"
    And backend selected playlist ids are "playlist-a"

  Scenario: Console can select multiple playlists
    Given the frontend console is logged into mocked MusicKit
    When the frontend clicks "Spec Playlist A"
    And the frontend clicks "Spec Playlist B"
    Then the frontend shows "2件のプレイリスト、5曲を選択中"
    And backend selected playlist ids are "playlist-a,playlist-b"

  Scenario: Console sends de-duplicated tracks for selected playlists
    Given the frontend console is logged into mocked MusicKit with overlapping playlists
    When the frontend clicks "Spec Playlist A"
    And the frontend clicks "Spec Playlist B"
    Then backend selected playlist ids are "playlist-a,playlist-b"
    And backend track ids are unique

  Scenario: Console can start and play a selected game
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    Then backend phase is "game" and step is "beforePlayback"
    When the frontend clicks "再生"
    Then backend phase is "game" and step is "playing"

  Scenario: Console playback seconds slider ignores presses inside the ring
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    And the frontend sets playback seconds to 10 on the slider ring
    And the frontend presses inside the playback seconds slider ring
    Then the playback seconds slider shows 10 seconds

  Scenario: Console page scrolls when swiping inside the playback seconds slider ring
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    And the frontend sets playback seconds to 10 on the slider ring
    And the frontend swipes up inside the playback seconds slider ring on a phone viewport
    Then the console page has scrolled
    And the playback seconds slider shows 10 seconds

  Scenario: Console page does not scroll when swiping on the playback seconds slider ring
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    And the frontend swipes up on the playback seconds slider ring on a phone viewport
    Then the console page has not scrolled

  Scenario: Console round track info starts closed and can be reopened per round
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    Then the console round track information is hidden
    When the frontend clicks "曲情報を開く"
    Then the console round track information is visible
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the console round track information is hidden
