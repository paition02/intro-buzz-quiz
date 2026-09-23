Feature: Host UI boundaries affect actual playback and judging

  # Source: INTRO_008
  Scenario: Track disclosure does not reset the active playback deadline
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And the host opens and closes track information during playback
    Then the active intro stops at its original deadline

  # Source: SESSION_002
  Scenario: A transient socket disconnect does not extend audible playback
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And the host briefly loses and restores the socket connection
    Then the active intro stops at its original deadline

  # Source: CONTROL_011
  Scenario: Opening and reloading a gameboard does not restart host audio
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And a gameboard is opened closed and reopened during playback
    Then the active intro stops at its original deadline

  # Source: UI_005 UI_006 UI_008 UI_009
  Scenario Outline: Answer input <action> does not submit a judgment
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host sends the answer input action "<action>"
    Then the input action does not judge or clear the answer rights

    Examples:
      | action |
      | IME Enter |
      | whitespace Enter |
      | no-match arrows Enter |
      | Escape |

  # Source: CONTROL_009
  Scenario: A manually wrong judgment clears the previous answer query
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host enters an answer without selecting a candidate
    And the host clicks the actual "不正解" button
    Then the next answer opportunity has no previous answer text

  # Source: CONTROL_002
  Scenario: Repeated correct button clicks only score and sound once
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host rapidly clicks "正解" 3 times
    Then one correct judgment and one result sound are produced

  # Source: CONTROL_004
  Scenario: Repeated next-round clicks do not skip a track
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host clicks the actual "ギブアップ" button
    Then the current track is being revealed
    When the host rapidly clicks "次のラウンドへ" 3 times
    Then only the immediately next round is prepared silently

  # Source: UI_004
  Scenario Outline: Slider boundary <change> stays within the supported range
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host changes the slider by "<change>"
    Then slider input does not start audio or advance the round

    Examples:
      | change |
      | minimum |
      | maximum |
