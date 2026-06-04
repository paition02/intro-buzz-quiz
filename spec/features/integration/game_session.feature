Feature: Full game session
  As a host, players, and audience
  I want the console, gameboard, action buttons, backend state, and MusicKit playback to stay synchronized
  So that a real physical-button intro quiz session can be played end to end

  Scenario: Host runs a complete one-round game and shows results
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    When action button "player-1" is pressed
    Then the gameboard shows joined player "player-1"
    When the host starts the game
    Then the console shows the game is before playback
    And the gameboard shows the playing stage is ready
    And MusicKit changes to the backend current track
    When the host plays the intro
    Then MusicKit starts playback
    And the gameboard shows the intro is playing
    When action button "player-1" is pressed
    Then backend answerer is "player-1"
    And the gameboard asks for an answer
    When the host judges the answer as "correct"
    Then the gameboard shows "正解"
    And the console plays a result sound
    And player "player-1" score is 1
    When the judging animation expires
    Then the gameboard shows the current track information
    And MusicKit plays the current track in full loop
    When the host shows results
    Then the gameboard shows backend scores in descending order

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
    Then backend answerer is "player-1"
    When the host judges the answer as "wrong"
    Then the gameboard shows "不正解"
    And the console plays a result sound
    And player "player-1" score is 0
    When the judging animation expires
    Then the backend is waiting before playback for the same track
    When action button "player-2" is pressed
    Then backend answerer is "player-2"
    And the gameboard asks for an answer

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
    Then backend answerer is "player-1"
    And action button "player-2" receives no reaction
    And the gameboard highlights joined player "player-1"

  Scenario: Intro can be replayed after nobody buzzes
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host plays the intro
    Then MusicKit starts playback
    And the gameboard shows the intro is playing
    When the intro playback duration expires without a buzz
    Then the backend is waiting before playback for the same track
    And the console can play the intro again
    When the host plays the intro
    And action button "player-1" is pressed
    Then backend answerer is "player-1"

  Scenario: Host gives up and advances to the next round
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host gives up
    Then the gameboard shows the current track information
    And MusicKit plays the current track in full loop
    When the host advances to the next round
    Then the console shows the game is before playback
    And the backend current track changed
    And MusicKit changes to the backend current track

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
    Then the console shows the ready phase
    And the gameboard shows the participation prompt
    And there are no joined players
    And selected playlist ids are "playlist-a"
    And the selected track count is 3

  Scenario: Reset returns every surface to the initial state
    Given the host console is logged into mocked MusicKit
    And the host selects playlist "Spec Playlist A"
    And the gameboard is open
    And action button "player-1" is open
    And action button "player-1" is joined
    And the host starts the game
    When the host resets the game
    Then the console shows the initialization phase
    And the gameboard waits for host login
    And there are no joined players
    And there are no selected tracks
    And MusicKit playback is stopped
