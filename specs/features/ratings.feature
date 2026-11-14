Feature: Rating beers
  Drinkers score a beer from 1 to 5. The catalogue shows how many ratings a
  beer has and their average to one decimal place.

  Background:
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv

  @operation:rateBeer
  Scenario: The first rating sets the average
    When a drinker rates "Morning After" 4
    Then the rating is recorded
    And the beer has 1 rating averaging 4

  @operation:rateBeer
  Scenario: The average covers every rating, to one decimal place
    Given "Morning After" has been rated 5, 4 and 4
    When a drinker rates "Morning After" 2
    Then the rating is recorded
    And the beer has 4 ratings averaging 3.8

  @operation:rateBeer @operation:getBeer
  Scenario: Ratings show on the beer in the catalogue
    Given "Morning After" has been rated 5 and 4
    When staff fetch "Morning After"
    Then the beer has 2 ratings averaging 4.5

  @operation:rateBeer @operation:updateBeer
  Scenario: Changing a beer keeps its ratings
    Given "Morning After" has been rated 5 and 4
    When staff change the abv of "Morning After" to 5.8
    Then the beer has 2 ratings averaging 4.5

  @operation:rateBeer
  Scenario Outline: A score is a whole number from 1 to 5
    When a drinker rates "Morning After" <score>
    Then the request is refused as invalid, pointing at "score"
    And "Morning After" still has no ratings

    Examples:
      | score |
      | 0     |
      | 6     |
      | 3.5   |
