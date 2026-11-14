Feature: Only staff change the catalogue
  Anyone can browse the catalogue and rate a beer. Adding, changing and
  retiring beers is for signed-in staff.

  @operation:create_beer
  Scenario: Adding a beer needs a signed-in member of staff
    When someone who is not signed in tries to add the beer "Morning After", an ipa at 5.6% abv
    Then they are asked to sign in
    And the catalogue lists no beers

  @operation:update_beer @operation:retire_beer
  Scenario Outline: Changing the catalogue needs a signed-in member of staff
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When someone who is not signed in tries to <action> "Morning After"
    Then they are asked to sign in
    And "Morning After" is still in the catalogue, an ipa at 5.6% abv

    Examples:
      | action |
      | rename |
      | retire |

  @operation:list_beers @operation:get_beer @operation:rate_beer
  Scenario: Browsing and rating need no sign-in
    Given the catalogue has the beer "Morning After", an ipa at 5.6% abv
    When someone who is not signed in lists the beers, fetches "Morning After" and rates it 5
    Then every one of those requests succeeds
