# The API's SLOs (specs/slos) set its alarms' thresholds, and without them the template's own
# stand: planned against fixture specs with mock providers, so no AWS account is needed.
mock_provider "aws" {
  # IAM refuses a policy that is not JSON; a mock's strings are random.
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}
mock_provider "awscc" {}
mock_provider "archive" {}

variables {
  name   = "plan-test"
  specs  = "tests/slo"
  repo   = "https://example.com/plan-test"
  domain = "plan-test"
  team   = "plan-test"

  monthly_budget_usd = 20
}

run "the_availability_slo_sets_the_share_of_5xx_that_alarms" {
  command = plan

  assert {
    condition     = abs(aws_cloudwatch_metric_alarm.api_5xx.threshold - 0.001) < 0.0000001
    error_message = "A target of 0.999 alarms when over 0.1% of requests are answered 5xx."
  }

  assert {
    condition     = one([for query in aws_cloudwatch_metric_alarm.api_5xx.metric_query : query.expression if query.id == "share"]) == "IF(requests > 0, errors / requests, 0)"
    error_message = "The alarm measures the share of requests answered 5xx, not their count."
  }
}

run "the_api_latency_slo_sets_its_percentile_and_threshold" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.api_latency.extended_statistic == "p95" && aws_cloudwatch_metric_alarm.api_latency.threshold == 800
    error_message = "The whole API's latency SLO is p95 within 800 ms."
  }
}

run "an_operations_latency_slo_alarms_on_its_route_alone" {
  command = plan

  assert {
    condition     = aws_cloudwatch_metric_alarm.operation_latency["list_things_v1"].dimensions.Route == "GET /v1/things" && aws_cloudwatch_metric_alarm.operation_latency["list_things_v1"].threshold == 500
    error_message = "list_things_v1's SLO alarms on GET /v1/things above 500 ms."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.operation_latency) == 1
    error_message = "Only an operation with an SLO of its own gets an alarm of its own."
  }

  assert {
    condition     = one([for setting in aws_apigatewayv2_stage.default.route_settings : setting.detailed_metrics_enabled if setting.route_key == "GET /v1/things"]) == true
    error_message = "The route an SLO measures has its detailed metrics on, or it has no Latency of its own."
  }

  assert {
    condition     = length([for setting in aws_apigatewayv2_stage.default.route_settings : setting if setting.route_key == "POST /v1/things"]) == 0
    error_message = "A route no SLO measures keeps API Gateway's defaults."
  }
}

run "without_slos_the_templates_thresholds_stand" {
  command = plan

  variables {
    specs = "tests/http"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.api_5xx.metric_name == "5xx" && aws_cloudwatch_metric_alarm.api_5xx.threshold == 1
    error_message = "Without an availability SLO, any 5xx alarms."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.api_latency.extended_statistic == "p99" && aws_cloudwatch_metric_alarm.api_latency.threshold == 3000
    error_message = "Without a latency SLO, p99 over 3 seconds alarms."
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.operation_latency) == 0
    error_message = "Without an operation's SLO, no operation has an alarm of its own."
  }
}
