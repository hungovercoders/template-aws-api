# What the stack may cost a month, the owner's to say in infra/budget.auto.tfvars.json,
# as the tags are theirs in infra/tags.auto.tfvars.json. An AWS Budgets budget on the
# stack's `service` tag notifies the alarm topic at 80% of the month's actual spend and
# at 100% of its forecast. Runbook: docs/runbook.md#budget.

variable "monthly_budget_usd" {
  description = "What the stack may cost a month, in US dollars. Set in infra/budget.auto.tfvars.json."
  type        = number
  default     = null

  validation {
    condition     = var.monthly_budget_usd != null && try(var.monthly_budget_usd > 0, false)
    error_message = "The stack has no monthly budget. Say what it may cost a month, in US dollars, in infra/budget.auto.tfvars.json (monthly_budget_usd), and commit it."
  }
}

data "aws_caller_identity" "current" {}

resource "aws_budgets_budget" "stack" {
  account_id   = data.aws_caller_identity.current.account_id
  name         = var.name
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # The stack's own cost: every resource carries `service` (tags.tf). AWS counts a tag
  # only once it is activated as a cost allocation tag - docs/deploying.md#cost.
  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:service$%s", var.name)]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [local.alarm_topic]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [local.alarm_topic]
  }

  depends_on = [aws_sns_topic_policy.alarms]
}

# A topic's policy replaces its default, so this says both: the account may use the
# topic as before, and AWS Budgets may publish to it, for this account only. Your own
# topic (alarm_topic_arn) needs the Budgets statement added by you.
data "aws_iam_policy_document" "alarm_topic" {
  count = var.alarm_topic_arn == "" ? 1 : 0

  statement {
    sid       = "Account"
    actions   = ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"]
    resources = [one(aws_sns_topic.alarms[*].arn)]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid       = "Budgets"
    actions   = ["SNS:Publish"]
    resources = [one(aws_sns_topic.alarms[*].arn)]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alarms" {
  count = var.alarm_topic_arn == "" ? 1 : 0

  arn    = one(aws_sns_topic.alarms[*].arn)
  policy = one(data.aws_iam_policy_document.alarm_topic[*].json)
}
