# What the owner says the stack may cost, and that its data can be restored: planned
# with mock providers, so no AWS account is needed.
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
  name = "plan-test"
  # A fixture contract, so the plan is the same whatever this API's own contract says.
  specs  = "tests/http"
  repo   = "https://example.com/plan-test"
  domain = "plan-test"
  team   = "plan-test"

  monthly_budget_usd = 20
}

run "the_table_can_be_restored" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.this.point_in_time_recovery[0].enabled
    error_message = "The table keeps point-in-time recovery, so it can be restored to any second of the last 35 days."
  }
}

run "an_alarm_links_to_its_section_of_the_runbook" {
  command = plan

  assert {
    condition     = endswith(aws_cloudwatch_metric_alarm.lambda_errors.alarm_description, "Runbook: https://example.com/plan-test/blob/HEAD/docs/runbook.md#lambda-errors")
    error_message = "An alarm ends on a link to its runbook section in the stack's own repository, so it can be opened from the alarm."
  }

  assert {
    condition     = aws_lambda_function.api.description != "" && aws_iam_role.lambda.description != "" && aws_apigatewayv2_api.this.description != ""
    error_message = "The Lambda, its role and the API each say what they are."
  }
}

run "the_stack_has_the_owners_budget" {
  command = plan

  assert {
    condition     = aws_budgets_budget.stack.limit_amount == "20.00" && aws_budgets_budget.stack.limit_unit == "USD" && aws_budgets_budget.stack.time_unit == "MONTHLY"
    error_message = "The budget is the owner's monthly_budget_usd, 20 US dollars a month."
  }

  assert {
    condition     = toset(one(aws_budgets_budget.stack.cost_filter).values) == toset(["user:service$plan-test"])
    error_message = "The budget counts only what carries the stack's service tag."
  }

  assert {
    condition     = toset([for notice in aws_budgets_budget.stack.notification : "${notice.notification_type} ${notice.threshold}"]) == toset(["ACTUAL 80", "FORECASTED 100"])
    error_message = "The budget notifies at 80% of actual and 100% of forecast spend."
  }

  assert {
    condition     = length(aws_sns_topic_policy.alarms) == 1
    error_message = "The alarm topic lets AWS Budgets publish to it."
  }
}

run "a_stack_without_a_budget_is_refused" {
  command = plan

  variables {
    monthly_budget_usd = null
  }

  expect_failures = [var.monthly_budget_usd]
}

run "a_budget_of_nothing_is_refused" {
  command = plan

  variables {
    monthly_budget_usd = 0
  }

  expect_failures = [var.monthly_budget_usd]
}
