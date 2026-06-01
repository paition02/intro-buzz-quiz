Feature: Action button page
  The smartphone action page is a full-screen, player-colored buzzer.

  Scenario: Action page renders a silent full-screen button
    When the frontend opens "/action"
    Then the document title is "早押しボタン | 早押しイントロクイズ"
    And the action button has no visible text
    And the action actor id is a UUID persisted in session storage

  Scenario: Pressing the action button joins before the game starts
    Given the frontend opens "/action"
    When the frontend action button is pressed
    Then one joined player is shown in backend state

  Scenario: Pressing during an answerable round marks the answerer on the board
    Given a backend game is before playback with actor "player-front"
    And the frontend opens "/action" as actor "player-front"
    When the backend host plays the intro for 1 seconds
    And the frontend action button is pressed
    Then backend answerer is "player-front"
