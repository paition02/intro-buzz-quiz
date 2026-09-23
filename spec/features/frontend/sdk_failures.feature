Feature: SDK failures through the actual console
  One SDK call is failed or deferred while all other calls still use the real SDK.

  Scenario Outline: Preparation failure in <method> is visible and permits reset recovery
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "<method>" operation has fault "reject"
    When the host clicks the actual "イントロで開始" button
    Then the SDK "<method>" failure is visible and reset stays usable
    When the host clicks the actual "リセット" button
    Then the actual console permits selecting and starting a new game

    Examples:
      | method |
      | setQueue |
      | play |
      | pause |

  Scenario Outline: Optional preloading <fault> does not block the current track
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "playNext" operation has fault "<fault>"
    When the host clicks the actual "イントロで開始" button
    Then the SDK "playNext" operation has been attempted
    And the prepared track remains playable despite the optional preload fault

    Examples:
      | fault |
      | reject |
      | hold-after |

  Scenario Outline: Reset supersedes a deferred preparation <method>
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "<method>" operation has fault "hold-before"
    When the host clicks the actual "イントロで開始" button
    Then the SDK "<method>" operation has been attempted
    When the host marks and resets the actual console
    And the SDK "<method>" operation is released
    Then a released obsolete load cannot audibly restart the reset game
    And the actual console permits selecting and starting a new game

    Examples:
      | method |
      | setQueue |
      | play |
      | pause |
      | playNext |

  Scenario Outline: Intro stop failure in <method> remains visible and recoverable
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    And the next SDK "<method>" operation has fault "reject"
    When the host starts an observed 0.5 second intro
    Then the SDK "<method>" failure is visible and reset stays usable
    When the host clicks the actual "リセット" button
    Then the actual console permits selecting and starting a new game

    Examples:
      | method |
      | pause |
      | seekToTime |
