Feature: Ratings sent as messages
  Ratings also arrive from elsewhere - a taproom's app - as messages on the
  catalogue's queue. One counts exactly as a drinker's rating does.

  Background:
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv

  @operation:receive_beer_rating_v1
  Scenario: A rating sent as a message is recorded
    When the taproom sends a rating of 4 for "Morning After"
    Then "Morning After" comes to have 1 rating averaging 4

  @operation:receive_beer_rating_v1
  Scenario: A rating delivered twice counts once
    When the taproom sends the same rating of 5 for "Morning After" twice
    And the taproom sends a rating of 3 for "Morning After"
    Then "Morning After" comes to have 2 ratings averaging 4

  @operation:receive_beer_rating_v1
  Scenario Outline: A score that is not a whole number from 1 to 5 is put aside
    When the taproom sends a rating of <score> for "Morning After"
    Then the message is put aside as not matching the contract
    And "Morning After" still has no ratings

    Examples:
      | score |
      | 0     |
      | 6     |
      | 3.5   |

  @operation:receive_beer_rating_v1
  Scenario: A rating for a beer that is not in the catalogue is put aside
    When the taproom sends a rating of 4 for a beer that is not in the catalogue
    Then the message is put aside because "there is no such beer"
