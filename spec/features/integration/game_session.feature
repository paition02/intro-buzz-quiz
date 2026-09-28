Feature: Full game session
  As a host, players, and audience
  I want the console, gameboard, and action buttons to stay synchronized
  So that a real physical-button intro quiz session can be played end to end

  Scenario: Host runs a complete one-round game and shows results
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    When action button "player-1" is pressed
    Then the gameboard shows joined player "player-1"
    When the host starts the game
    Then the console shows the stage "ラウンド待機ステップ"
    And the gameboard shows the playing stage is ready
    When the host plays the intro
    Then the gameboard shows the intro is playing
    When action button "player-1" is pressed
    Then the gameboard shows "player-1" answering
    When the host judges the answer as "correct"
    Then the gameboard shows "正解"
    And the console plays a result sound
    And the gameboard shows player "player-1" with 1 point
    And the gameboard shows revealed track information
    When the host shows results
    Then the gameboard results show player "player-1" with 1 point

  Scenario: Host runs a complete jacket game and shows results
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    When action button "player-1" is pressed
    Then the gameboard shows joined player "player-1"
    When the host starts a jacket game
    Then the gameboard shows a jacket hint
    When action button "player-1" is pressed
    Then the gameboard shows "player-1" answering
    When the host judges the answer as "correct"
    Then the gameboard shows "正解"
    And the gameboard shows player "player-1" with 1 point
    And the gameboard shows revealed album information
    When the host shows results
    Then the gameboard results show player "player-1" with 1 point

  Scenario: Wrong answer returns to the same round and accepts another buzz
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-2" is open
    And action buttons "player-1,player-2" are joined
    And the host starts the game
    When the host plays the intro
    And action button "player-1" is pressed
    Then the gameboard shows "player-1" answering
    When the host judges the answer as "wrong"
    Then the gameboard shows "不正解"
    And the console plays a result sound
    And the gameboard shows player "player-1" with 0 points
    And the console shows the stage "ラウンド待機ステップ"
    When action button "player-2" is pressed
    Then the gameboard shows "player-2" answering

  Scenario: Only the first player to buzz gets answer rights
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-2" is open
    And action buttons "player-1,player-2" are joined
    And the host starts the game
    When the host plays the intro
    And action button "player-1" is pressed
    And action button "player-2" is pressed
    Then the gameboard shows "player-1" answering
    And action button "player-2" receives no reaction

  Scenario: Intro can be replayed after nobody buzzes
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host plays the intro
    Then the gameboard shows the intro is playing
    When the intro playback duration expires without a buzz
    Then the console shows the same track waiting before playback
    And the console can play the intro again
    When the host plays the intro
    And action button "player-1" is pressed
    Then the gameboard shows "player-1" answering

  Scenario: Host gives up and advances to the next round
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host gives up
    Then the gameboard shows revealed track information
    When the host advances to the next round
    Then the console shows the stage "ラウンド待機ステップ"

  Scenario: Next game keeps selected tracks but clears participants and scores
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    And player "player-1" has scored once
    And the host shows results
    When the host starts the next game setup
    Then the console shows the stage "準備フェーズ"
    And the gameboard shows the participation prompt
    And the console shows no participants
    And the frontend shows "1件のプレイリスト、3曲を選択中"

  Scenario: Reset returns every surface to the initial state
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host resets the game
    Then the console shows the stage "準備フェーズ"
    And the gameboard shows the participation prompt
    And the console shows no participants
    And the console shows no selected playlists
