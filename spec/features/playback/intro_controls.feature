Feature: Intro controls through the actual host UI
  Exercise the real MusicKit SDK with mocked Apple Music HTTP responses.
  A failed UI action is never replaced with a direct console socket command.
  Media state and position are observed; these tests do not verify physical audio output.

  # Source: @INTRO_001 @reported
  Scenario: Changing duration three times still permits buzzing wrong and replaying
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1,1.5" seconds
    And the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host clicks the actual "不正解" button
    Then the same round becomes playable without changing the score
    When the host replays the same track for "1" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

  # Source: @INTRO_004 @INTRO_005 @INTRO_007 @INTRO_015
  Scenario Outline: Repeated duration sequence <sequence> starts at zero and stops
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "<sequence>" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | sequence       |
      | 0.5,0.5,0.5    |
      | 0.5,1,1.5      |
      | 1.5,1,0.5      |
      | 0.5,1.5,0.5,1  |

  # Source: @BUZZ_008 @ROUND_009
  Scenario: A completed intro timer cannot interrupt the reveal
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host clicks the actual "正解" button
    Then the current track keeps playing in reveal after the old intro deadline
    When the host clicks the actual "結果発表へ" button
    Then results are silent and participant "player-1" has 1 point

  # Source: @INTRO_002 @BUZZ_013
  Scenario: Buzzing stops playback even while the play promise is unresolved
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1" seconds
    And the next MusicKit play promise is held after media playback starts
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the held MusicKit play promise is released
    And the host clicks the actual "不正解" button
    Then the same round becomes playable without changing the score
    When the host replays the same track for "0.5" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

  # Source: @ASYNC_015 @RESET_009
  Scenario: Reset stops playback even while the play promise is unresolved
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    And the next MusicKit play promise is held after media playback starts
    When the host starts an observed 1.5 second intro
    And the host clicks the actual "リセット" button
    Then the reset state is silent before the held promise is released
    When the held MusicKit play promise is released
    Then the reset state remains silent after the old intro deadline

  # Source: @INTRO_002 @ASYNC_018
  Scenario: The third intro stops on time before its play promise resolves
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1" seconds
    And the next MusicKit play promise is held after media playback starts
    And the host starts an observed 1.5 second intro
    Then the intro stops by its media deadline before the held promise is released
    When the held MusicKit play promise is released
    Then the same round becomes playable without changing the score

  # Source: @INTRO_006
  Scenario: Committing a new duration immediately before play uses the new duration
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "1.5,0.5" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance
