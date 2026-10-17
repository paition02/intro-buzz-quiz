Feature: Intro controls through the actual host UI
  Exercise the real MusicKit SDK with mocked Apple Music HTTP responses.
  A failed UI action is never replaced with a direct console socket command.
  Media state and position are observed; these tests do not verify physical audio output.

  Scenario Outline: Changing duration then <playback> permits buzzing wrong and replaying
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1,1.5" seconds
    And the host starts playback setting "<playback>"
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host clicks the actual "不正解" button
    Then the same round becomes playable without changing the score
    When the host replays the same track for "1" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | playback |
      | 1.5 |
      | ∞ |

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

  Scenario: A completed intro timer cannot interrupt the reveal
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host clicks the actual "正解" button
    Then the current track keeps playing in reveal after the old intro deadline
    When the host clicks the actual "結果発表へ" button
    Then results are silent and participant "player-1" has 1 point

  Scenario Outline: Buzzing stops playback even while the play promise is unresolved for <playback>
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1" seconds
    And the next MusicKit play promise is held after media playback starts
    When the host starts playback setting "<playback>"
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the held MusicKit play promise is released
    And the host clicks the actual "不正解" button
    Then the same round becomes playable without changing the score
    When the host replays the same track for "0.5" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | playback |
      | 1.5 |
      | ∞ |

  Scenario Outline: Reset stops playback even while the play promise is unresolved for <playback>
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    And the next MusicKit play promise is held after media playback starts
    When the host starts playback setting "<playback>"
    And the host clicks the actual "リセット" button
    Then the reset state is silent before the held promise is released
    When the held MusicKit play promise is released
    Then the reset state remains silent after the old intro deadline

    Examples:
      | playback |
      | 1.5 |
      | ∞ |

  Scenario: The third intro stops on time before its play promise resolves
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "0.5,1" seconds
    And the next MusicKit play promise is held after media playback starts
    And the host starts an observed 1.5 second intro
    Then the intro stops by its media deadline before the held promise is released
    When the held MusicKit play promise is released
    Then the same round becomes playable without changing the score

  Scenario: Committing a new duration immediately before play uses the new duration
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "1.5,0.5" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

  Scenario Outline: Playback seconds follow the same continuous scale for a <duration> second track
    Given a prepared intro whose selected tracks last <duration> seconds
    When the host selects position <position> percent on the playback seconds control
    Then the playback seconds control shows <seconds> seconds without starting playback

    Examples:
      | duration | position | seconds |
      | 30       | 0        | 0.1     |
      | 30       | 2.5      | 0.5     |
      | 30       | 5        | 1       |
      | 30       | 50       | 11.4    |
      | 30       | 90       | 25.5    |
      | 180      | 0        | 0.1     |
      | 180      | 2.5      | 0.5     |
      | 180      | 5        | 1       |
      | 180      | 50       | 24.1    |
      | 180      | 90       | 122.5   |

  Scenario: The playback control endpoint loops the current track and still accepts a buzz
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host drags the playback seconds control to its endpoint
    Then the playback control shows "∞ ループ" without starting playback
    When the host starts playback setting "∞"
    Then the same track repeats past its end while waiting for a buzz
    When participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights

  Scenario: Selecting loop during a finite intro applies only to the next playback
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And the host selects playback setting "∞" during playback
    Then the active intro stops at its original deadline
    When the host starts playback setting "∞"
    Then the same track repeats past its end while waiting for a buzz

  Scenario: Selecting finite seconds during a loop applies only to the next playback
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts playback setting "∞"
    And the host selects playback setting "0.5" during playback
    Then the same track repeats past its end while waiting for a buzz
    When participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host clicks the actual "不正解" button
    Then the same round becomes playable without changing the score
    When the host starts the selected finite intro
    Then the active intro stops at its original deadline


  Scenario Outline: The complete <duration> second track is selectable before the loop endpoint
    Given a prepared intro whose selected tracks last <duration> seconds
    When the host selects the full track length before the loop endpoint
    Then the playback seconds control shows <duration> seconds without starting playback

    Examples:
      | duration |
      | 30 |
      | 180 |
