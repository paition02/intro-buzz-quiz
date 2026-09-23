Feature: Complete game rounds and jacket audio through host controls

  # Source: ROUND_007 ROUND_008 ROUND_014 FLOW_005
  Scenario Outline: A <count> track <mode> game reaches results without skipped rounds
    Given an observed console with <count> selected tracks
    When the observed console finishes all rounds in "<mode>" mode
    Then the observed results contain no active media

    Examples:
      | count | mode |
      | 1 | intro |
      | 2 | intro |
      | 4 | intro |
      | 6 | intro |
      | 1 | jacket |
      | 3 | jacket |

  # Source: JACKET_016 ROUND_010
  Scenario Outline: A subsequent game switches from <before> to <after>
    Given an observed console with 1 selected tracks
    When the observed console finishes all rounds in "<before>" mode
    And the observed console begins a subsequent "<after>" game
    Then the reveal plays the expected full track or album queue

    Examples:
      | before | after |
      | intro | intro |
      | intro | jacket |
      | jacket | intro |
      | jacket | jacket |

  # Source: JACKET_003 JACKET_004
  Scenario: Jacket reveal plays the complete album and loops back to its first track
    Given an observed console with 1 selected tracks
    When the observed console starts "jacket" mode
    And the host clicks the actual "ギブアップ" button
    Then the reveal plays the expected full track or album queue
    And the jacket returns to its own first track after a full album cycle
    When the host clicks the actual "結果発表へ" button
    Then the observed results contain no active media

  # Source: JACKET_002 JACKET_008 JACKET_009 JACKET_014
  Scenario Outline: Jacket UI preserves <mode> and <gray> through judging
    Given a selected intro with an observed MusicKit player and participant "player-1"
    When the observed console starts "jacket" mode
    And the jacket UI sets mode "<mode>" and grayscale "<gray>"
    Then jacket judging preserves settings and the next round resets only its hint

    Examples:
      | mode | gray |
      | pixelated | true |
      | missingBlocks | false |
      | tileShuffle | true |
      | circleReveal | false |
      | zoomRotateCrop | true |
      | edgeReveal | false |
