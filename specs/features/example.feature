# The behaviour: what the API does, in your business language, a scenario
# for each rule and edge you have agreed. While this file is all comments it
# holds no scenario. Every operation in specs/contracts/openapi.v<N>.yaml
# needs at least one scenario tagged with its operationId; the write-spec
# skill writes them with you. Replace this file with your own, for example:
#
# Feature: Things
#   Anyone can list the things in the catalogue; only staff add them.
#
#   @operation:create_thing_v0
#   Scenario: A member of staff adds a thing
#     Given I am signed in as staff
#     When I add a thing called "Widget"
#     Then it is created
#     And listing the things includes "Widget"
#
#   @operation:list_things_v0
#   Scenario: The list is empty before anything is added
#     When I list the things
#     Then there are none
