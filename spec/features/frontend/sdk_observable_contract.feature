Feature: SDK success responses must match observable media state

  Scenario: A resolved play call with no media movement is an observable failure
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    And the next SDK "play" operation has fault "noop"
    When the host clicks the actual "再生" button
    Then a no-op play response is not presented as a successful intro

  Scenario: A resolved pause call cannot hide continuing audio
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    And the next SDK "pause" operation has fault "noop"
    When the host starts an observed 0.5 second intro
    Then the active intro stops at its original deadline

  Scenario: A successful queue response loading another song is not prepared
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "setQueue" operation has fault "wrong-song"
    When the host clicks the actual "イントロで開始" button
    Then the wrong loaded song is rejected before enabling play

  Scenario Outline: Preparation restores the original volume <volume>
    Given a selected intro with an observed MusicKit player and participant "player-1"
    When the host sets media volume to <volume>
    And the host clicks the actual "イントロで開始" button
    Then the prepared media volume remains <volume>

    Examples:
      | volume |
      | 0 |
      | 0.4 |

  Scenario: Preparation failure does not leave a temporary mute behind
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "pause" operation has fault "reject"
    When the host sets media volume to 0.4
    And the host clicks the actual "イントロで開始" button
    Then a failed warmup restores the original media volume

  Scenario: Explicit mute during warmup is not overwritten by the old volume
    Given a selected intro with an observed MusicKit player and participant "player-1"
    And the next SDK "pause" operation has fault "hold-before"
    When the host sets media volume to 0.4
    And the host clicks the actual "イントロで開始" button
    And the host mutes during a deferred warmup
    Then the prepared media volume remains 0
