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

  Scenario: Console playback seconds reset on a new round
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    Then the playback seconds slider shows 0.5 seconds
    When the frontend sets playback seconds to 10 on the slider ring
    And the frontend clicks "ギブアップ"
    Then the playback seconds slider shows 10 seconds
    When the frontend clicks "次のラウンドへ"
    Then the playback seconds slider shows 0.5 seconds
    When the frontend sets playback seconds to 10 on the slider ring
    Then the playback seconds slider shows 10 seconds

  Scenario: Console round track info starts closed and can be reopened per round
    Given the frontend console selected playlist "Spec Playlist A"
    When the frontend clicks "イントロで開始"
    Then the console round track information is hidden
    When the frontend clicks "曲情報を開く"
    Then the console round track information is visible
    When the frontend clicks "ギブアップ"
    And the frontend clicks "次のラウンドへ"
    Then the console round track information is hidden

  Scenario: Console answer card is enabled only while a player has answer rights
    Given the frontend console selected playlist "Spec Playlist A"
    And action button "player-1" is joined
    When the frontend clicks "イントロで開始"
    Then the console answer input is disabled
    When the backend host plays the intro for 1 seconds
    And backend actor "player-1" presses the action API
    Then the console answer input is enabled

  Scenario: Console answer card suggests tracks with artwork and artist
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types "Track" into the answer input
    Then the console answer suggestions are "Track 1,Track 2,Track 3"
    And each console answer suggestion shows artwork and artist

  Scenario: Console answer card tolerates typos
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types "Trak 2" into the answer input
    Then the first console answer suggestion is "Track 2"

  Scenario: Console answer card shows at most 5 suggestions
    Given the frontend console has actor "player-1" answering in an intro game with 8 tracks
    When the frontend types "Track" into the answer input
    Then the console shows 5 answer suggestions

  Scenario: Console answer card shows no suggestions for empty input
    Given the frontend console has actor "player-1" answering in an intro game
    Then the console shows 0 answer suggestions
    When the frontend types "Track" into the answer input
    And the frontend clears the answer input
    Then the console shows 0 answer suggestions

  Scenario: Choosing the round track in the answer card judges correct
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend chooses the round track in the answer card
    Then backend phase is "game" and step is "correct"
    And player "player-1" score is 1
    And the console answer input is empty
    And the console shows 0 answer suggestions

  Scenario: Choosing another track in the answer card judges wrong
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend chooses a track other than the round track in the answer card
    Then backend phase is "game" and step is "wrong"
    And player "player-1" score is 0

  Scenario: Console answer card suggests albums in jacket mode
    Given the frontend console has actor "player-1" answering in a jacket game
    When the frontend types "Album" into the answer input
    Then the console answer suggestions are "Album 1,Album 2,Album 3"
    And each console answer suggestion shows artwork and artist
    When the frontend chooses the round album in the answer card
    Then backend phase is "game" and step is "correct"
    And player "player-1" score is 1

  Scenario: Choosing another album in the answer card judges wrong
    Given the frontend console has actor "player-1" answering in a jacket game
    When the frontend chooses an album other than the round album in the answer card
    Then backend phase is "game" and step is "wrong"
    And player "player-1" score is 0

  Scenario: Console answer card answers the first suggestion with Enter
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types the round track title into the answer input
    Then the console highlights answer suggestion 1
    When the frontend presses "Enter" in the answer input
    Then backend phase is "game" and step is "correct"
    And player "player-1" score is 1
    And the console answer input is empty

  Scenario: Console answer card moves the highlight with arrow keys and wraps
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types "Track" into the answer input
    And the frontend presses "ArrowDown" 2 times in the answer input
    Then the console highlights answer suggestion 3
    When the frontend presses "ArrowDown" 1 times in the answer input
    Then the console highlights answer suggestion 1
    When the frontend presses "ArrowUp" 1 times in the answer input
    Then the console highlights answer suggestion 3
    When the frontend answers with the highlighted suggestion by Enter
    Then the backend judged the highlighted suggestion

  Scenario: Console answer card resets the highlight when the input changes
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types "Track" into the answer input
    And the frontend presses "ArrowDown" 2 times in the answer input
    Then the console highlights answer suggestion 3
    When the frontend types "Track " into the answer input
    Then the console highlights answer suggestion 1

  Scenario: Console answer card clears the input with Escape
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend types "Track" into the answer input
    And the frontend presses "Escape" in the answer input
    Then the console answer input is empty
    And the console shows 0 answer suggestions

  Scenario: Console answer card ignores Enter without suggestions
    Given the frontend console has actor "player-1" answering in an intro game
    When the frontend presses "Enter" in the answer input
    Then backend phase is "game" and step is "answering"
    And the console answer input is enabled
