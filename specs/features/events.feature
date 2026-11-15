Feature: What happens to a beer is published
  Other services learn what happens in the catalogue from the events it
  publishes: a beer was created, updated, retired or rated. Nothing is
  published for something that did not happen.

  @operation:publish_beer_created @operation:create_beer
  Scenario: Adding a beer publishes that it was created
    When staff add the beer "Morning After", an ipa at 5.6% abv
    Then a "created" event is published for "Morning After"
    And the event says it is an ipa at 5.6% abv

  @operation:publish_beer_updated @operation:update_beer
  Scenario: Changing a beer publishes that it was updated
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff change the abv of "Morning After" to 5.8
    Then an "updated" event is published for "Morning After"
    And the event says it is an ipa at 5.8% abv

  @operation:publish_beer_updated @operation:update_beer
  Scenario: Renaming a beer publishes its new name
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff rename "Morning After" to "Night Before"
    Then an "updated" event is published for "Morning After"
    And the event names the beer "Night Before"

  @operation:publish_beer_retired @operation:retire_beer
  Scenario: Retiring a beer publishes that it was retired
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff retire "Morning After"
    Then a "retired" event is published for "Morning After"
    And the event names the beer "Morning After"

  @operation:publish_beer_rated @operation:rate_beer
  Scenario: Rating a beer publishes the rating
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When a drinker rates "Morning After" 4
    Then a "rated" event is published for "Morning After"
    And the event carries the score 4

  @operation:publish_beer_rated @operation:receive_beer_rating
  Scenario: A rating sent as a message is published like any other
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When the taproom sends a rating of 5 for "Morning After"
    Then a "rated" event is published for "Morning After"
    And the event carries the score 5

  @operation:publish_beer_created @operation:create_beer
  Scenario: A beer that was not added publishes nothing
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff add the beer "Morning After", an ipa at 5.6% abv
    Then the request is refused because the name is taken
    And only one "created" event has been published

  @operation:publish_beer_rated @operation:rate_beer
  Scenario: A rating that was refused publishes nothing
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When a drinker rates "Morning After" 6
    Then no "rated" event has been published
