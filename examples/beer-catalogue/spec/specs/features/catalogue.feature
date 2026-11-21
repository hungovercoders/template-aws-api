Feature: Keeping the beer catalogue
  Brewery staff add the beers they brew, keep the details current and
  retire the ones they stop brewing.

  @operation:create_beer_v0
  Scenario: Adding a beer to the catalogue
    When staff add the beer "Morning After", an ipa at 5.6% abv
    Then the beer is added
    And the beer is named "Morning After", an ipa at 5.6% abv
    And the beer has no ratings yet
    And the response says where to fetch the new beer

  @operation:create_beer_v0
  Scenario: Strength is recorded to one decimal place
    When staff add the beer "Morning After", an ipa at 5.64% abv
    Then the beer is added
    And the beer is named "Morning After", an ipa at 5.6% abv

  @operation:create_beer_v0 @operation:get_beer_v0
  Scenario: A beer that was added can be fetched
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff fetch "Morning After"
    Then the beer is returned
    And the beer is named "Morning After", an ipa at 5.6% abv

  @operation:list_beers_v0
  Scenario: An empty catalogue lists no beers
    When staff list the beers
    Then the list is empty

  @operation:list_beers_v0
  Scenario: Listing the catalogue in name order
    Given the catalogue has these beers:
      | name            | style | abv |
      | Morning After   | ipa   | 5.6 |
      | Hair of the Dog | stout | 7.2 |
      | Last Orders     | lager | 4.1 |
    When staff list the beers
    Then the list is, in order:
      | Hair of the Dog |
      | Last Orders     |
      | Morning After   |

  @operation:list_beers_v0
  Scenario: Listing only one style
    Given the catalogue has these beers:
      | name            | style | abv |
      | Morning After   | ipa   | 5.6 |
      | Hair of the Dog | stout | 7.2 |
      | Second Wind     | ipa   | 6.4 |
    When staff list the ipa beers
    Then the list is, in order:
      | Morning After |
      | Second Wind   |

  @operation:update_beer_v0
  Scenario: Changing a beer's strength leaves the rest alone
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff change the abv of "Morning After" to 5.8
    Then the beer is returned
    And the beer is named "Morning After", an ipa at 5.8% abv

  @operation:update_beer_v0
  Scenario: Renaming a beer
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff rename "Morning After" to "The Morning After"
    Then the beer is returned
    And the beer is named "The Morning After", an ipa at 5.6% abv

  @operation:retire_beer_v0
  Scenario: A retired beer is gone from the catalogue
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff retire "Morning After"
    Then the beer is retired
    And "Morning After" can no longer be fetched
    And the catalogue lists no beers

  @operation:retire_beer_v0 @operation:create_beer_v0
  Scenario: A retired beer's name can be used again
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    And staff have retired "Morning After"
    When staff add the beer "Morning After", an ale at 4.4% abv
    Then the beer is added
