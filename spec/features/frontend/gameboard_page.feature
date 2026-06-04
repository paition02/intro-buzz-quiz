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

  Scenario: Gameboard receives the initial backend state even when it arrives immediately
    Given the backend is ready with 3 tracks
    And the next frontend state event is emitted immediately on connection
    When the frontend opens "/gameboard"
    Then the frontend shows "ボタンを押してご参加ください"
    And the frontend shows "Track 1"

  Scenario: Gameboard initialization view shows joined players
    Given action button "player-front" is joined
    When the frontend opens "/gameboard"
    Then the gameboard shows joined player "player-front"

  Scenario: Gameboard shows reconnecting state while disconnected
    Given the backend is ready with 3 tracks
    And the frontend opens "/gameboard"
    When the frontend socket disconnects
    Then the frontend shows "再接続中"
    When the frontend socket reconnects
    Then the frontend shows "ボタンを押してご参加ください"

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

  Scenario: Gameboard correct view highlights the answerer
    Given a backend game has actor "player-front" answering
    When the frontend opens "/gameboard"
    And the backend host judges the answer as "correct"
    Then the frontend shows "正解"
    And the frontend highlights backend actor "player-front"

  Scenario: Gameboard wrong view returns to the same round after the animation
    Given a backend game has actor "player-front" answering
    When the frontend opens "/gameboard"
    And the backend host judges the answer as "wrong"
    Then the frontend shows "不正解"
    When the judging animation expires
    Then backend phase is "game" and step is "beforePlayback"

  Scenario: Gameboard reveal view shows current track artwork information
    Given a backend game is before playback with actor "player-front"
    When the frontend opens "/gameboard"
    And the backend host gives up
    Then the frontend shows the backend current track information

  Scenario: Gameboard results view shows sorted scores
    Given a backend game has results with actor "player-front" scoring once
    When the frontend opens "/gameboard"
    Then the frontend shows "結果発表！"
    And the frontend shows backend scores in descending order
