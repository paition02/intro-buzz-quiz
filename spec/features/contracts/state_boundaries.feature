Feature: Server contracts across game states
  Backend-only coverage; media playback is tested separately.

  # Source: CONTROL_013
  Scenario Outline: Invalid command <command> in <state> does not mutate state
    Given the contract state is "<state>"
    When the contract sends rejected command "<command>"
    Then the entire contract state is unchanged

    Examples:
      | state | command |
      | initialization | play |
      | initialization | start |
      | ready | play |
      | ready | start |
      | intro:before | correct |
      | intro:before | wrong |
      | intro:before | next-round |
      | intro:before | show-results |
      | intro:before | next-game |
      | intro:before | play-ended |
      | intro:playing | play |
      | intro:playing | give-up |
      | intro:playing | start |
      | intro:playing | select-playlists |
      | intro:answering | play |
      | intro:answering | give-up |
      | intro:answering | next-round |
      | intro:wrong | play |
      | intro:wrong | correct |
      | intro:wrong | correct-feedback-ended |
      | intro:correct | wrong |
      | intro:correct | wrong-feedback-ended |
      | intro:reveal | play |
      | intro:reveal | correct |
      | intro:reveal | play-ended |
      | intro:last-reveal | next-round |
      | intro:results | correct |
      | intro:results | play |
      | intro:results | next-round |
      | jacket:before | play |
      | jacket:before | play-ended |
      | intro:before | set-jacket-mode |
      | jacket:answering | set-jacket-mode |
      | jacket:reveal | set-jacket-grayscale |
      | jacket:results | set-jacket-hint-percent |


  # Source: BUZZ_011 BUZZ_015 GAP_006
  Scenario Outline: Rejected buzz in <state> by <actor> preserves the entire state
    Given the contract state is "<state>"
    When contract actor "<actor>" buzzes expecting <status>
    Then the entire contract state is unchanged

    Examples:
      | state | actor | status |
      | intro:before | P | 409 |
      | intro:playing | X | 409 |
      | intro:answering | P | 204 |
      | intro:answering | Q | 204 |
      | intro:answering | X | 204 |
      | intro:wrong | Q | 204 |
      | intro:correct | Q | 204 |
      | intro:correct-reveal | Q | 204 |
      | intro:reveal | Q | 409 |
      | intro:results | Q | 409 |
      | jacket:before | X | 409 |
      | jacket:answering | Q | 204 |


  # Source: BUZZ_003 BUZZ_014 JACKET_001
  Scenario Outline: A buzz is accepted in <state>
    Given the contract state is "<state>"
    When contract actor "Q" buzzes expecting 200
    Then the contract has exactly one answerer without changing scores

    Examples:
      | state |
      | intro:playing |
      | intro:played |
      | jacket:before |


  # Source: BUZZ_009
  Scenario Outline: Concurrent buzzing has one winner in <state>
    Given the contract state is "<state>"
    When both contract players buzz concurrently
    Then the contract has exactly one answerer without changing scores

    Examples:
      | state |
      | intro:playing |
      | jacket:before |


  # Source: CONTROL_002 CONTROL_003
  Scenario Outline: Only the first of judgments <first> and <second> is applied
    Given the contract state is "intro:answering"
    When the contract applies competing judgments "<first>" then "<second>"
    Then only the first judgment affects the contract score

    Examples:
      | first | second |
      | correct | correct |
      | wrong | wrong |
      | correct | wrong |
      | wrong | correct |


  # Source: BUZZ_003 BUZZ_004 BUZZ_005 BUZZ_016
  Scenario Outline: Repeated wrong answers <count> allow another player to score
    Given the contract state is "intro:before"
    When the contract repeats wrong answers <count> times
    Then only the final contract answer scores

    Examples:
      | count |
      | 1 |
      | 3 |
      | 10 |
      | 30 |


  # Source: ROUND_007 ROUND_008 ROUND_010 ROUND_012 ROUND_014
  Scenario Outline: All <count> rounds in <mode> survive the next game boundary
    Given a contract game with <count> tracks in "<mode>" mode
    When the contract completes every round and starts another game
    Then the next contract game starts at zero with the original selection

    Examples:
      | count | mode |
      | 1 | intro |
      | 2 | intro |
      | 3 | intro |
      | 4 | intro |
      | 6 | intro |
      | 51 | intro |
      | 1 | jacket |
      | 2 | jacket |
      | 3 | jacket |
      | 4 | jacket |
      | 6 | jacket |
      | 51 | jacket |


  # Source: RESET_009 RESET_003
  Scenario Outline: Reset from <state> clears game and permits selection
    Given the contract state is "<state>"
    When the contract resets twice
    Then the contract reset clears the game and permits a new selection

    Examples:
      | state |
      | initialization |
      | ready |
      | intro:before |
      | intro:playing |
      | intro:played |
      | intro:answering |
      | intro:wrong |
      | intro:correct |
      | intro:reveal |
      | intro:results |
      | jacket:before |
      | jacket:answering |
      | jacket:reveal |
      | jacket:results |


  # Source: JACKET_008 JACKET_009 JACKET_014
  Scenario Outline: Jacket settings <mode> and <gray> survive judging and advancement
    Given the contract state is "jacket:before"
    When the contract sets jacket mode "<mode>" and grayscale "<gray>"
    Then the jacket contract keeps settings after wrong and resets only the next hint

    Examples:
      | mode | gray |
      | pixelated | true |
      | pixelated | false |
      | missingBlocks | true |
      | missingBlocks | false |
      | tileShuffle | true |
      | tileShuffle | false |
      | circleReveal | true |
      | circleReveal | false |
      | zoomRotateCrop | true |
      | zoomRotateCrop | false |
      | edgeReveal | true |
      | edgeReveal | false |


  # Source: JACKET_015
  Scenario Outline: Jacket hint <value> is validated as <expected>
    Given the contract state is "jacket:before"
    When the contract submits hint JSON <value> expecting <expected>

    Examples:
      | value | expected |
      | 1 | 1 |
      | 100 | 100 |
      | 47.4 | 47 |
      | 47.6 | 48 |
      | 0 | rejected |
      | 101 | rejected |
      | null | rejected |
      | "text" | rejected |
      | true | rejected |
      | {} | rejected |
      | [] | rejected |


  # Source: GAP_007
  Scenario: A no-reaction buzz does not consume cooldown
    Given the contract state is "intro:answering"
    When a no-reaction buzz is followed immediately by another answer opportunity
    Then Q has the contract answer rights
