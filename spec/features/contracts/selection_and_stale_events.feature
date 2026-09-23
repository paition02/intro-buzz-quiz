Feature: Track identity and obsolete game notifications

  # Source: LIBRARY_007 LIBRARY_008 LIBRARY_009 LIBRARY_010 LIBRARY_011 LIBRARY_012 ROUND_006
  Scenario Outline: Selection metadata <variant> produces <tracks> tracks and <albums> albums
    Given the contract state is "ready"
    When the contract selects metadata variant "<variant>"
    Then the contract retains <tracks> tracks and <albums> albums

    Examples:
      | variant | tracks | albums |
      | same-title-different-id | 2 | 2 |
      | duplicate-id | 1 | 1 |
      | missing-id | 1 | 1 |
      | missing-title | 1 | 1 |
      | missing-artwork | 2 | 2 |
      | missing-album | 2 | 0 |
      | same-album | 2 | 1 |
      | same-name-different-album-artist | 2 | 2 |

  # Source: ROUND_011
  Scenario: Replacing a next-game selection discards the previous track IDs
    Given the contract state is "intro:results"
    When the contract replaces the next game selection
    Then the contract only includes the new track IDs

  # Source: RESET_004 RESET_005 RESET_006 RESET_010
  Scenario Outline: An old <notification> must not affect a new game in the same step
    Given the contract state is "<state>"
    When the contract receives a stale "<notification>" from an earlier game
    Then the stale notification leaves the new game untouched

    Examples:
      | state | notification |
      | intro:playing | play-ended |
      | intro:correct | correct-feedback-ended |
      | intro:wrong | wrong-feedback-ended |
