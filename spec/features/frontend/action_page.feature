Feature: Action button page
  The smartphone action page is a full-screen, player-colored buzzer.

  Scenario: Action page renders a silent full-screen button
    When the frontend opens "/action"
    Then the document title is "早押しボタン | 早押しイントロクイズ"
    And the action button has no visible text
    And the action page keeps the same player identity after reload

  Scenario: Action page works outside a secure context
    Given secure-context-only web APIs are unavailable
    When the frontend opens "/action"
    Then the action page keeps the same player identity after reload

  Scenario: Pressing the action button joins before the game starts
    Given the frontend opens "/action"
    When the frontend action button is pressed
    Then the host console shows a participant

  Scenario: Pressing during an answerable round marks the answerer on the board
    Given the frontend opens "/action"
    And the gameboard is open
    When the frontend action button is pressed
    Then the host console shows a participant
    When the host selects playlist "Spec Playlist A" and starts the game
    And the host plays a 1 second intro
    And the frontend action button is pressed
    Then the gameboard asks for an answer
