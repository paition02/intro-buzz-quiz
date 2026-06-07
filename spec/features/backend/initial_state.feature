Feature: Initial state and routes
  As a regression suite
  I want the server to expose the expected initial state and HTTP routes
  So that clients can reconnect and load pages reliably

  Scenario: Server starts in initialization state
    Given a fresh server state
    Then the phase is "initialization"
    And the step is "idle"
    And there are no players
    And there are no tracks

  Scenario: Public state sorts players by id
    Given a fresh server state
    When actor "z-player" presses the action API
    And actor "a-player" presses the action API
    Then players are ordered by id

  Scenario: MusicKit token endpoint returns a supported status
    When the client requests the MusicKit token
    Then the MusicKit token status is supported

  Scenario: Configured MusicKit token endpoint returns a developer token
    Given Apple Music credentials are configured
    When the client requests the MusicKit token
    Then the HTTP status is 200
    And the MusicKit token response contains a JWT token
    And the MusicKit token response contains an ISO expiration time

  Scenario: MusicKit token endpoint rejects missing credentials
    Given Apple Music credentials are not configured
    When the client requests the MusicKit token
    Then the HTTP status is 401
    And the MusicKit token response contains error "Apple Music credentials are not configured"

  Scenario Outline: SPA routes return the app shell
    When the client requests route "<route>"
    Then the HTTP status is 200

    Examples:
      | route      |
      | /          |
      | /console   |
      | /gameboard |
      | /action    |

  Scenario: Unknown routes return not found
    When the client requests route "/missing"
    Then the HTTP status is 404
