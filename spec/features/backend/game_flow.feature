Feature: Game flow
  As a host
  I want rounds, judging, results, and next game actions to be deterministic
  So that quiz progress can be regression tested

  Scenario: Intro playback returns to beforePlayback when nobody buzzes
    Given a game is before playback with joined players "player-1"
    When the host plays the intro for 0.1 seconds
    Then the step is "playing"
    And has played current track is true
    When the playback timeout expires
    Then the step is "beforePlayback"

  Scenario: Correct answer increments score and reveals the track
    Given player "player-1" has answer rights
    When the host judges the answer as "correct"
    Then the step is "correct"
    And last result is "correct"
    And player "player-1" score is 1
    When the judging animation expires
    Then the step is "reveal"

  Scenario: Wrong answer returns to beforePlayback without score
    Given player "player-1" has answer rights
    When the host judges the answer as "wrong"
    Then the step is "wrong"
    And last result is "wrong"
    And player "player-1" score is 0
    When the judging animation expires
    Then the step is "beforePlayback"
    And there is no answerer

  Scenario: Unknown judge result is treated as wrong
    Given player "player-1" has answer rights
    When the host judges the answer as "unexpected"
    Then the step is "wrong"
    And last result is "wrong"

  Scenario: Give up reveals from beforePlayback
    Given a game is before playback with joined players "player-1"
    When the host gives up
    Then the step is "reveal"
    And there is no answerer
    And there is no last result

  Scenario: Show results clears current track
    Given the game is revealing the answer
    When the host shows results
    Then the step is "results"
    And there is no current track
    And there is no answerer

  Scenario: Next round advances through shuffled order
    Given a started game with 3 tracks
    When the host advances to the next round
    Then the current game order index is 1
    And the current track follows game track order

  Scenario: Next game clears players but keeps selected tracks
    Given the game is showing results with players "player-1,player-2"
    When the host starts the next game
    Then the phase is "ready"
    And the step is "idle"
    And there are no players
    And the track count is 3
    And selected playlist ids are "playlist-a"
