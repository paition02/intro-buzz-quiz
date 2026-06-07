Feature: Action API
  As a player or physical button
  I want the action endpoint to use status codes
  So that buttons can react without parsing a response body

  Scenario: Empty actor id is rejected
    When actor "   " presses the action API
    Then the HTTP status is 400
    And the response body is empty

  Scenario: Action toggles participation during initialization
    Given a fresh server state
    When actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And player "player-1" is joined
    When actor "player-1" waits for cooldown
    And actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And player "player-1" is not joined

  Scenario: Action toggles participation during ready phase
    Given the host console is ready
    When actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And player "player-1" is joined
    When actor "player-1" waits for cooldown
    And actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And player "player-1" is not joined

  Scenario: Cooldown returns 429 before phase behavior
    Given a fresh server state
    When actor "player-1" presses the action API
    And actor "player-1" presses the action API
    Then the HTTP status is 429
    And the response body is empty
    And the retry-after header is "1"

  Scenario: Unjoined player cannot buzz during playback
    Given a game is before playback with joined players "player-1"
    When the host plays the intro for 1 seconds
    And actor "stranger" presses the action API
    Then the HTTP status is 409
    And the response body is empty

  Scenario: Joined player can buzz during playback
    Given a game is before playback with joined players "player-1"
    When the host plays the intro for 1 seconds
    And actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And the step is "answering"
    And answerer is "player-1"

  Scenario: Later buzzers are ignored after answerer is fixed
    Given a game is before playback with joined players "player-1,player-2"
    When the host plays the intro for 1 seconds
    And actor "player-1" presses the action API
    And actor "player-2" presses the action API
    Then the HTTP status is 204
    And the response body is empty
    And answerer is "player-1"

  Scenario: Buzzing before first playback is rejected
    Given a game is before playback with joined players "player-1"
    When actor "player-1" presses the action API
    Then the HTTP status is 409
    And the response body is empty
    And the step is "beforePlayback"

  Scenario: Rejected action does not consume cooldown
    Given a game is before playback with joined players "player-1"
    When actor "player-1" presses the action API
    Then the HTTP status is 409
    When the host plays the intro for 1 seconds
    And actor "player-1" presses the action API
    Then the HTTP status is 200
    And the step is "answering"
    And answerer is "player-1"

  Scenario: Buzzing after playback ended is allowed
    Given a game is before playback with joined players "player-1"
    When the host plays the intro for 0.1 seconds
    And the playback timeout expires
    And actor "player-1" presses the action API
    Then the HTTP status is 200
    And the response body is empty
    And the step is "answering"
    And answerer is "player-1"
