Feature: Host console state transitions
  As a host
  I want console actions to update the shared game state
  So that all screens follow the same source of truth

  Scenario: Host console readiness moves the game to ready
    Given a fresh server state
    When the host console becomes ready
    Then the phase is "ready"
    And the step is "idle"

  Scenario: Selecting multiple playlists stores selected tracks
    Given the host console is ready
    When the host selects playlists:
      | playlist_id | playlist_name | track_count |
      | playlist-a  | Playlist A    | 2           |
      | playlist-b  | Playlist B    | 3           |
    Then selected playlist ids are "playlist-a,playlist-b"
    And the track count is 5
    And the current track is cleared

  Scenario: Invalid tracks are filtered
    Given the host console is ready
    When the host sends tracks with missing id or title
    Then the track count is 1

  Scenario: Starting without tracks does not enter game
    Given the host console is ready
    When the host starts the game
    Then the phase is "ready"
    And the step is "idle"

  Scenario: Starting with tracks loads the first round
    Given the host console is ready
    And players "player-1,player-2" are joined
    And the host has selected 3 tracks
    When the host starts the game
    Then the phase is "game"
    And the step is "beforePlayback"
    And the current track is one of the selected tracks
    And all player scores are 0

  Scenario: Play is ignored until a round is ready
    Given the host console is ready
    And the host has selected 3 tracks
    When the host plays the intro for 1 seconds without starting the game
    Then the phase is "ready"
    And the step is "idle"

  Scenario: Judge is ignored unless a player has answer rights
    Given a game is before playback with joined players "player-1"
    When the host judges the answer as "correct"
    Then the step is "beforePlayback"
    And player "player-1" score is 0

  Scenario: Showing results is ignored before reveal
    Given a game is before playback with joined players "player-1"
    When the host shows results
    Then the phase is "game"
    And the step is "beforePlayback"
    And the current track is one of the selected tracks

  Scenario: Next round is ignored before reveal
    Given a started game with 3 tracks
    When the host advances to the next round before reveal
    Then the current track is unchanged

  Scenario: Reset restores initial state
    Given the host console is ready
    And players "player-1" are joined
    And the host has selected 2 tracks
    When the host resets the game
    Then the phase is "initialization"
    And the step is "idle"
    And there are no players
    And there are no tracks
