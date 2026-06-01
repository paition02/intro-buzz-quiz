Feature: Host console state transitions
  As a host
  I want console actions to update the shared game state
  So that all screens follow the same source of truth

  Scenario: Host login moves the game to ready
    Given a fresh server state
    When the host logs in
    Then the phase is "ready"
    And the step is "idle"
    And host login is true

  Scenario: Selecting multiple playlists stores selected tracks
    Given the host is logged in
    When the host selects playlists:
      | playlist_id | playlist_name | track_count |
      | playlist-a  | Playlist A    | 2           |
      | playlist-b  | Playlist B    | 3           |
    Then selected playlist ids are "playlist-a,playlist-b"
    And playlist names are "Playlist A,Playlist B"
    And the track count is 5
    And the current track is cleared

  Scenario: Invalid tracks are filtered
    Given the host is logged in
    When the host sends tracks with missing id or title
    Then the track count is 1

  Scenario Outline: Playback seconds are normalized
    Given a fresh server state
    When the host sets playback seconds to <input>
    Then playback seconds is <expected>

    Examples:
      | input | expected |
      | 2.5   | 2.5      |
      | 0     | 0.5      |
      | -1    | 0.5      |
      | 0.01  | 0.1      |
      | 99    | 30       |

  Scenario: Starting without tracks does not enter game
    Given the host is logged in
    When the host starts the game
    Then the phase is "ready"
    And the step is "idle"
    And the message contains "曲を選択"

  Scenario: Starting with tracks loads the first round
    Given the host is logged in
    And players "player-1,player-2" are joined
    And the host has selected 3 tracks
    When the host starts the game
    Then the phase is "game"
    And the step is "beforePlayback"
    And the current track is one of the selected tracks
    And has played current track is false
    And all player scores are 0
    And game track order contains all selected track indexes

  Scenario: Reset restores initial state
    Given the host is logged in
    And players "player-1" are joined
    And the host has selected 2 tracks
    When the host resets the game
    Then the phase is "initialization"
    And the step is "idle"
    And host login is false
    And playback seconds is 0.5
    And there are no players
    And there are no tracks
