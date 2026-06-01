Feature: Gameboard page
  The gameboard presents each game step with dedicated content.

  Scenario: Gameboard ready view shows the participation prompt and selected tracks
    Given the backend is ready with 3 tracks
    When the frontend opens "/gameboard"
    Then the document title is "ゲームボード | 早押しイントロクイズ"
    And the frontend shows "ボタンを押してご参加ください"
    And the frontend shows "Track 1"
    And the frontend shows "Track 2"
    And the frontend shows "Track 3"

  Scenario: Gameboard playing view shows only the music symbol stage
    Given a backend game is before playback with actor "player-front"
    When the frontend opens "/gameboard"
    And the backend host plays the intro for 1 seconds
    Then the frontend shows "♪"
    And the frontend does not show "解答をどうぞ！"

  Scenario: Gameboard answering view shows the answer prompt
    Given a backend game is before playback with actor "player-front"
    When the frontend opens "/gameboard"
    And the backend host plays the intro for 1 seconds
    And backend actor "player-front" presses the action API
    Then the frontend shows "解答をどうぞ！"

  Scenario: Gameboard reveal view shows current track artwork information
    Given a backend game is before playback with actor "player-front"
    When the frontend opens "/gameboard"
    And the backend host gives up
    Then the frontend shows the backend current track information

  Scenario: Gameboard results view shows sorted scores
    Given a backend game has results with actor "player-front" scoring once
    When the frontend opens "/gameboard"
    Then the frontend shows "1"
