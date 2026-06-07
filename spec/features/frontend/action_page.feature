Feature: Action button page
  The smartphone action page is a full-screen, player-colored buzzer.

  Scenario: Action page renders a silent full-screen button
    When the frontend opens "/action"
    Then the document title is "早押しボタン | 早押しイントロクイズ"
    And the action button has no visible text
    And the action page keeps the same player identity after reload

  Scenario: Pressing the action button joins before the game starts
    Given the frontend opens "/action"
    When the frontend action button is pressed
    Then one joined player is shown in backend state

  Scenario: Pressing during an answerable round marks the answerer on the board
    Given the frontend opens "/action"
    When the frontend action button is pressed
    Then one joined player is shown in backend state
    When the backend starts a game with the joined action player
    And the backend host plays the intro for 1 seconds
    And the frontend action button is pressed
    Then the joined action player has answer rights
