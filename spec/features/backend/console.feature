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

  Scenario: Jacket album candidates are grouped by album name regardless of case, spacing and track artist
    Given the host console is ready
    When the host selects tracks of one album with differing track artists and name spacing
    Then the track count is 3
    And the album count is 1
    And the album lists 3 tracks

  Scenario: Tracks sharing an album name form one jacket album
    Given the host console is ready
    When the host selects multiple tracks from one album
    Then the track count is 3
    And the album count is 1

  Scenario: Jacket album candidates ignore EP and Single suffixes
    Given the host console is ready
    When the host selects tracks of albums "Shared Album - Single" and "Shared Album - EP"
    Then the album count is 1
    And the album name is "Shared Album - EP"

  Scenario: Jacket album candidates share a library album
    Given the host console is ready
    When the host selects tracks of albums "Disc Album [Disc 2]" and "Disc Album [Disc 1]" in one library album
    Then the album count is 1
    And the album name is "Disc Album [Disc 1]"

  Scenario: Jacket album candidates share a catalog album
    Given the host console is ready
    When the host selects tracks of albums "Catalog Album" and "Catalog Album (Deluxe)" in one catalog album
    Then the album count is 1
    And the album name is "Catalog Album"

  Scenario: Jacket album candidates share an identical jacket image
    Given the host console is ready
    When the host selects tracks of albums "First Album" and "Second Album" with the same jacket image
    Then the album count is 1
    And the album name is "First Album"

  Scenario: Jacket album candidates with different jacket images stay apart
    Given the host console is ready
    When the host selects tracks of albums "First Album" and "Second Album" with different jacket images
    Then the album count is 2

  Scenario: Jacket start waits for jacket analysis
    Given the host console is ready
    When the host selects a track whose jacket image is still loading
    Then the jacket albums are being analyzed
    When the host starts a jacket game
    Then the console action is rejected with "ジャケットを解析中です"
    When the jacket image finishes loading
    Then the album count is 1

  Scenario: Starting without tracks does not enter game
    Given the host console is ready
    When the host starts the game
    Then the phase is "ready"
    And the step is "idle"

  Scenario: Starting without a mode does not enter game
    Given the host console is ready
    And the host has selected 3 tracks
    When the host starts the game without choosing a mode
    Then the phase is "ready"
    And the step is "idle"

  Scenario: Starting with tracks loads the first round
    Given the host console is ready
    And players "player-1,player-2" are joined
    And the host has selected 3 tracks
    When the host starts the game
    Then the phase is "game"
    And the step is "beforePlayback"
    And the quiz mode is "intro"
    And the current track is one of the selected tracks
    And all player scores are 0

  Scenario: Starting a jacket game stores the selected mode
    Given the host console is ready
    And the host has selected 3 tracks
    When the host starts a jacket game
    Then the phase is "game"
    And the step is "beforePlayback"
    And the quiz mode is "jacket"

  Scenario: Jacket settings update during a jacket round
    Given a jacket game is before playback with joined players "player-1"
    When the host sets jacket mode to "tileShuffle"
    Then the jacket mode is "tileShuffle"
    When the host sets jacket grayscale to true
    Then jacket grayscale is true
    When the host sets jacket hint percent to 47
    Then the jacket hint percent is 47

  Scenario: Action QR display toggles during the ready phase
    Given the host console is ready
    When the host shows the action QR on the gameboard
    Then the action QR is shown
    When the host hides the action QR on the gameboard
    Then the action QR is hidden

  Scenario: Action QR display is ignored before the console is ready
    Given a fresh server state
    When the host shows the action QR on the gameboard
    Then the action QR is hidden

  Scenario: Action QR display is ignored during a game
    Given a game is before playback with joined players "player-1"
    When the host shows the action QR on the gameboard
    Then the action QR is hidden

  Scenario: Starting the game hides the action QR
    Given the host console is ready
    And the host has selected 3 tracks
    And the action QR is shown on the gameboard
    When the host starts the game
    Then the phase is "game"
    And the action QR is hidden

  Scenario: Resetting hides the action QR
    Given the host console is ready
    And the action QR is shown on the gameboard
    When the host resets the game
    Then the action QR is hidden

  Scenario: Switching to the next LAN keeps a reachable origin
    Given a fresh server state
    When the host switches to the next LAN
    Then the LAN origin is an http origin or absent

  Scenario: Jacket settings are ignored during an intro round
    Given a game is before playback with joined players "player-1"
    When the host sets jacket mode to "tileShuffle"
    Then the jacket mode is "pixelated"

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
