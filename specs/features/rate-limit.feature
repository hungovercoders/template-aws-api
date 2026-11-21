Feature: Callers are asked to slow down
  Anyone may browse the catalogue, but not so fast that it suffers for
  everyone else: a caller who calls faster than the contract's rate limit
  is told to slow down, and can carry on once they have.

  @operation:list_beers_v0
  Scenario: A caller who lists the beers too fast is told to slow down
    When a caller lists the beers faster than the catalogue allows
    Then some of those calls are told to slow down
    And the rest list the beers
