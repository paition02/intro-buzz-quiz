Feature: Playlist input boundaries through the library UI

  # Source: LIBRARY_001 LIBRARY_014
  Scenario Outline: A playlist with <count> tracks is selected without missing page boundaries
    Given library track responses are limited to fifty items per page
    And an observed console with <count> selected tracks
    Then the library selection contains exactly <count> distinct track IDs

    Examples:
      | count |
      | 0 |
      | 1 |
      | 49 |
      | 50 |
      | 51 |
      | 100 |
      | 101 |

  # Source: LIBRARY_004
  Scenario: Deselecting an overlapping playlist does not remove a shared track
    Given the observed library has overlapping playlists
    When the host selects both playlists and deselects the first
    Then the overlapping track remains selected exactly once

  # Source: LIBRARY_005
  Scenario: A late playlist response cannot repopulate a reset game
    Given the observed library has overlapping playlists
    When the first playlist track request is held while the host resets
    And the old playlist track request is released
    Then the reset library selection stays empty
