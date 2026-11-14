Feature: The catalogue stays consistent when changes arrive together
  Staff and drinkers use the catalogue at the same time. However their
  requests overlap, names stay unique, no name is lost and every rating counts.

  @operation:create_beer
  Scenario: The same name added twice at once is added only once
    When staff add the beer "Morning After", an ipa at 5.6% abv, twice at once
    Then one request adds the beer and the other is refused because the name is taken
    And the catalogue holds 1 beer

  @operation:update_beer
  Scenario: Renaming a beer two ways at once keeps one name and frees the rest
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff rename "Morning After" to "Last Orders" and to "Second Wind" at once
    Then "Morning After" is now named either "Last Orders" or "Second Wind"
    And whichever of "Morning After", "Last Orders" and "Second Wind" it is not named can be given to a new beer

  @operation:update_beer @operation:retire_beer
  Scenario: Retiring a beer while it is being renamed frees both names
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff retire "Morning After" and rename it to "Last Orders" at once
    Then the catalogue lists no beers
    And whichever of "Morning After" and "Last Orders" it is not named can be given to a new beer

  @operation:rate_beer
  Scenario: Ratings that arrive together all count
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When 10 drinkers rate "Morning After" 4 at once
    Then "Morning After" has 10 ratings averaging 4
