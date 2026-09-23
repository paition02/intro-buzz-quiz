Feature: Reset and logout while the host progresses through a game

  # Source: RESET_001 RESET_003 RESET_009
  Scenario Outline: Reset at <stage> stops old audio and permits a new game
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host reaches observed stage "<stage>"
    And the host rapidly clicks "リセット" 3 times
    Then reset stays silent after old feedback and playback timers expire
    And the actual console permits selecting and starting a new game

    Examples:
      | stage |
      | beforePlayback |
      | played |
      | playing |
      | answering |
      | wrong |
      | correct |
      | reveal |
      | results |

  # Source: SESSION_005 GAP_005
  Scenario: Logout while playing stops the media
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And the host logs out during an observed intro
    Then logout stops media and does not restart at the old deadline

  # Source: SESSION_005
  Scenario: A deferred load released after logout cannot start audio
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "setQueue" operation has fault "hold-before"
    When the host clicks the actual "イントロで開始" button
    And the host logs out while an initial load is deferred
    Then the delayed load after logout never starts audible media
