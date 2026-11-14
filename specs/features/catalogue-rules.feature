Feature: Rules the catalogue enforces
  Beer names are unique, the details must make sense, and a beer that is not
  in the catalogue cannot be fetched, changed, retired or rated.

  @operation:create_beer
  Scenario: Two beers cannot share a name
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff add the beer "Morning After", a stout at 7.0% abv
    Then the request is refused because the name is taken

  @operation:create_beer
  Scenario: Names are compared ignoring case and surrounding spaces
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff add the beer "  morning AFTER ", a stout at 7.0% abv
    Then the request is refused because the name is taken

  @operation:update_beer
  Scenario: A beer cannot be renamed to another beer's name
    Given the catalogue has these beers:
      | name            | style | abv |
      | Morning After   | ipa   | 5.6 |
      | Hair of the Dog | stout | 7.2 |
    When staff rename "Hair of the Dog" to "Morning After"
    Then the request is refused because the name is taken

  @operation:update_beer
  Scenario: A beer can be renamed to a different spelling of its own name
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff rename "Morning After" to "MORNING AFTER"
    Then the beer is returned
    And the beer is named "MORNING AFTER", an ipa at 5.6% abv

  @operation:create_beer
  Scenario Outline: A beer needs sensible details
    When staff try to add a beer with <problem>
    Then the request is refused as invalid, pointing at "<field>"
    And the catalogue lists no beers

    Examples:
      | problem                  | field  |
      | no name                  | name   |
      | a blank name             | name   |
      | a name of 61 characters  | name   |
      | an unknown style         | style  |
      | a negative abv           | abv    |
      | an abv above 20          | abv    |
      | an unexpected detail     |        |

  @operation:update_beer
  Scenario: A change must change something
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When staff send no changes for "Morning After"
    Then the request is refused as invalid

  @operation:list_beers
  Scenario: Beers cannot be listed by a style that does not exist
    When staff list the cider beers
    Then the request is refused as invalid, pointing at "style"

  @operation:get_beer @operation:update_beer @operation:retire_beer @operation:rate_beer
  Scenario Outline: A beer that is not in the catalogue cannot be used
    When staff <action> a beer that is not in the catalogue
    Then the beer is not found

    Examples:
      | action |
      | fetch  |
      | change |
      | retire |
      | rate   |

  @operation:get_beer
  Scenario: A beer is identified by a UUID
    When staff fetch the beer with id "not-a-uuid"
    Then the request is refused as invalid, pointing at "beer_id"
