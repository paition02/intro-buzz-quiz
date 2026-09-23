Feature: Authentication and library failure recovery

  # Source: SESSION_006
  Scenario: Authorization rejection permits a second real login attempt
    Given the observed console is unauthenticated
    And the next SDK "authorize" operation has fault "reject"
    When the host clicks the actual "ログイン" button
    Then authorization failure remains unauthenticated and permits retry

  # Source: SESSION_007
  Scenario: Developer token failure recovers after reload
    Given the developer token endpoint fails until restored
    When the host observes token failure and reloads after restoration
    Then the restored console permits library selection

  # Source: LIBRARY_006 LIBRARY_016
  Scenario Outline: Library failure HTTP <status> recovers through reload
    Given library listing fails with HTTP <status> until restored
    When the host attempts login with the broken library listing
    Then library failure leaves a usable reload control and can recover

    Examples:
      | status |
      | 200 |
      | 401 |
      | 500 |
