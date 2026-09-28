Feature: Gameboard page
  The gameboard presents each game step with dedicated content.

  Scenario: Gameboard ready view shows the participation prompt and selected tracks
    Given the host selected playlist "Spec Playlist A"
    When the frontend opens "/gameboard"
    Then the document title is "ゲームボード | 早押しイントロクイズ"
    And the frontend shows "ボタンを押してご参加ください"
    And the frontend shows "Track 1"
    And the frontend shows "Track 2"
    And the frontend shows "Track 3"

  Scenario: Gameboard initialization view shows joined players
    Given action button "player-front" is joined
    When the frontend opens "/gameboard"
    Then the gameboard shows joined player "player-front"

  Scenario: Gameboard shows reconnecting state while disconnected
    Given the host selected playlist "Spec Playlist A"
    And the frontend opens "/gameboard"
    When the frontend socket disconnects
    Then the frontend shows "再接続中"
    When the frontend socket reconnects
    Then the frontend shows "ボタンを押してご参加ください"

  Scenario: Gameboard shows a discreet fullscreen button on pointer movement
    Given the gameboard fullscreen API is mocked
    When the frontend opens "/gameboard"
    Then the gameboard fullscreen button is hidden
    When the pointer moves over the gameboard
    Then the gameboard fullscreen button is shown
    When the gameboard fullscreen button is clicked
    Then the gameboard requests fullscreen with hidden navigation UI
    And the gameboard fullscreen button hides after the pointer stops

  Scenario: Gameboard playing view shows only the music symbol stage
    Given the host started an intro game with actor "player-front"
    When the frontend opens "/gameboard"
    And the host plays a 1 second intro
    Then the frontend shows "♪"
    And the frontend does not show "解答をどうぞ！"

  Scenario: Gameboard jacket view shows an obfuscated jacket
    Given the host selected playlist "Spec Playlist A"
    And action button "player-front" is joined
    And the host starts a jacket game
    When the frontend opens "/gameboard"
    Then the gameboard shows a jacket hint

  Scenario: Gameboard answering view shows the answer prompt
    Given the host started an intro game with actor "player-front"
    When the frontend opens "/gameboard"
    And the host plays a 1 second intro
    And action button "player-front" is pressed
    Then the frontend shows "解答をどうぞ！"

  Scenario: Gameboard correct view highlights the answerer
    Given the host started an intro game with actor "player-front" answering
    When the frontend opens "/gameboard"
    And the host judges the answer as "correct"
    Then the frontend shows "正解"
    And the frontend highlights player "player-front"

  Scenario: Gameboard wrong view returns to the same round after the animation
    Given the host started an intro game with actor "player-front" answering
    When the frontend opens "/gameboard"
    And the host judges the answer as "wrong"
    Then the frontend shows "不正解"
    And the console shows the stage "ラウンド待機ステップ"
    And the frontend shows "♪"

  Scenario: Gameboard reveal view shows revealed track information
    Given the host started an intro game with actor "player-front"
    When the frontend opens "/gameboard"
    And the host gives up
    Then the frontend shows revealed track information

  Scenario: Gameboard jacket reveal view shows revealed album information
    Given the host selected playlist "Spec Playlist A"
    And action button "player-front" is joined
    And the host starts a jacket game
    When the frontend opens "/gameboard"
    And the host gives up
    Then the gameboard shows revealed album information

  Scenario: Gameboard results view shows sorted scores
    Given the host finished a round with actor "player-front" scoring once
    When the frontend opens "/gameboard"
    And the host shows results
    Then the frontend shows "結果発表！"
    And the gameboard results show player "player-front" with 1 point
