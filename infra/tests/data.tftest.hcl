# The bucket keeps what the data contracts say, for as long as they say: planned
# against fixture contracts with mock providers, so no AWS account is needed.
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
  specs  = "tests/data"
  repo   = "https://example.com/plan-test"
  domain = "plan-test"
  team   = "plan-test"

  monthly_budget_usd = 20
}

run "each_copy_is_kept_for_its_own_retention" {
  command = plan

  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.data[0].rule : rule.expiration[0].days if rule.id == "retention-v0"]) == 30
    error_message = "v0's raw JSON is kept for its server's retention, P30D."
  }

  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.data[0].rule : rule.expiration[0].days if rule.id == "retention-v1"]) == 2555
    error_message = "v1's server says no retention, so its raw JSON is kept for the default, P7Y: 2555 days."
  }

  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.data[0].rule : rule.expiration[0].days if rule.id == "retention-v0-parquet"]) == 730
    error_message = "v0's Parquet is kept for the contract's retention, 2 years."
  }

  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.data[0].rule : rule.expiration[0].days if rule.id == "retention-v1-parquet"]) == 400
    error_message = "v1's Parquet is kept for the contract's retention, 400 days."
  }

  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.data[0].rule : rule.expiration[0].days if rule.id == "retention-errors"]) == 2555
    error_message = "What could not be placed is kept as long as the longest promise."
  }
}
