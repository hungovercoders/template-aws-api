# Each route is throttled as its contract's x-rate-limit says, and only then: planned
# against fixture contracts with mock providers, so no AWS account is needed.
mock_provider "aws" {
  # IAM refuses a policy that is not JSON; a mock's strings are random.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}
mock_provider "awscc" {}
mock_provider "archive" {}

variables {
  name   = "plan-test"
  specs  = "tests/http"
  repo   = "https://example.com/plan-test"
  domain = "plan-test"
  team   = "plan-test"
}

run "each_route_is_throttled_as_its_contract_says" {
  command = plan

  assert {
    condition     = one([for setting in aws_apigatewayv2_stage.default.route_settings : setting.throttling_rate_limit if setting.route_key == "GET /v1/things"]) == 25
    error_message = "v1's routes take its requests_per_second, 25."
  }

  assert {
    condition     = one([for setting in aws_apigatewayv2_stage.default.route_settings : setting.throttling_burst_limit if setting.route_key == "GET /v1/things"]) == 50
    error_message = "v1's routes take its burst, 50."
  }

  assert {
    condition     = length([for setting in aws_apigatewayv2_stage.default.route_settings : setting if setting.route_key == "GET /v2/things"]) == 0
    error_message = "v2 has no rate limit, so its routes are not throttled."
  }
}
