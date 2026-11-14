Feature: Listing the catalogue a page at a time
  A catalogue can be long, so it is listed in pages. Each page says whether
  there are more beers to list, and the pages together are the whole
  catalogue in name order, ignoring case and accents.

  Background:
    Given the catalogue has these beers:
      | name            | style | abv |
      | Morning After   | ipa   | 5.6 |
      | Hair of the Dog | stout | 7.2 |
      | last orders     | lager | 4.1 |
      | Second Wind     | ipa   | 6.4 |
      | Éclair Noir     | stout | 8.0 |

  @operation:list_beers
  Scenario: Reading the catalogue two beers at a time
    When staff list the beers 2 at a time
    Then the list is, in order:
      | Éclair Noir     |
      | Hair of the Dog |
    And there are more beers to list
    When staff list the next page
    Then the list is, in order:
      | last orders   |
      | Morning After |
    And there are more beers to list
    When staff list the next page
    Then the list is, in order:
      | Second Wind |
    And there are no more beers to list

  @operation:list_beers
  Scenario: A page that ends with the last beer is the last page
    When staff list the beers 5 at a time
    Then the list holds 5 beers
    And there are no more beers to list

  @operation:list_beers
  Scenario: Paging through one style
    When staff list the ipa beers 1 at a time
    Then the list is, in order:
      | Morning After |
    And there are more beers to list
    When staff list the next page
    Then the list is, in order:
      | Second Wind |
    And there are no more beers to list

  @operation:list_beers
  Scenario: A page holds 20 beers unless asked otherwise
    Given the catalogue has 20 more beers
    When staff list the beers
    Then the list holds 20 beers
    And there are more beers to list

  @operation:list_beers
  Scenario Outline: A page holds between 1 and 100 beers
    When staff list the beers <size> at a time
    Then the request is refused as invalid, pointing at "limit"

    Examples:
      | size |
      | 0    |
      | 101  |

  @operation:list_beers
  Scenario: A page marker the catalogue did not issue is refused
    When staff list the beers from the page marker "made-up"
    Then the page marker is refused
