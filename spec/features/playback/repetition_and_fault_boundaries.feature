Feature: Short playback repetition and combined user actions

  # Source: INTRO_016
  Scenario Outline: Every one of <count> short replays completes independently
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host repeats <count> intros lasting 0.1 seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | count |
      | 3 |
      | 10 |
      | 50 |
      | 100 |

  # Source: INTRO_015
  Scenario Outline: Small fractional duration pattern <sequence> is applied on every replay
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host replays the same track for "<sequence>" seconds
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | sequence |
      | 0.1,0.2,0.3,0.9,1.1 |
      | 1,0.1,1,0.1 |

  # Source: BUZZ_016 FLOW_004
  Scenario Outline: <count> wrong judgments preserve subsequent playback
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host repeats buzzing and wrong judgment <count> times
    Then every completed intro started at the beginning and stopped within its duration tolerance

    Examples:
      | count |
      | 1 |
      | 3 |
      | 10 |

  # Source: CONTROL_001
  Scenario: A same-turn play burst does not create multiple playback intervals
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host clicks play repeatedly in the same event turn
    Then the repeated play clicks produce one bounded playback interval

  # Source: GAP_010
  Scenario: Result sound failure does not trap the game in correct feedback
    Given a prepared intro with an observed MusicKit player and participant "player-1"
    When the host starts an observed 1.5 second intro
    And participant "player-1" buzzes during observed playback
    Then the media stops and participant "player-1" keeps the answer rights
    When the host disables result sound creation and judges correct
    Then correct feedback still reaches reveal with one point
