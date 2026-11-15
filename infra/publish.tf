# Published events: what the API does is published to EventBridge, each event
# a CloudEvent the AsyncAPI contract describes as a `send` operation.
#
# An operation does not publish. It writes the event to the table in the same
# transaction as its data (the outbox, src/lib/outbox.ts), so either both
# happen or neither does. The table's stream hands each new outbox item to the
# forwarder function - the same bundle, another entry point - which puts it on
# the bus and removes it. Delivery is at least once, and in order only for
# one item: consumers tell a repeat by the event's id.

variable "event_bus_name" {
  description = "An existing EventBridge bus to publish to. Empty: the stack creates its own, named after it."
  type        = string
  default     = ""
}

variable "event_archive_days" {
  description = "Days the events are kept in an EventBridge archive, to replay to a new consumer. 0: no archive."
  type        = number
  default     = 30
}

variable "event_log_days" {
  description = "Days every published event is kept in a log group, to follow them with `task events:tail`. 0: no log."
  type        = number
  default     = 1
}

variable "event_subscriber_accounts" {
  description = "AWS account ids that may put rules on the stack's own bus, to subscribe to its events."
  type        = list(string)
  default     = []
}

locals {
  own_bus  = var.event_bus_name == ""
  bus_name = local.own_bus ? one(aws_cloudwatch_event_bus.events[*].name) : var.event_bus_name
  bus_arn  = local.own_bus ? one(aws_cloudwatch_event_bus.events[*].arn) : one(data.aws_cloudwatch_event_bus.existing[*].arn)
}

# --- The bus ------------------------------------------------------------------

resource "aws_cloudwatch_event_bus" "events" {
  count = local.own_bus ? 1 : 0

  name = var.name
}

data "aws_cloudwatch_event_bus" "existing" {
  count = local.own_bus ? 0 : 1

  name = var.event_bus_name
}

data "aws_partition" "current" {}

# Another account subscribes by putting a rule on this bus.
data "aws_iam_policy_document" "subscribers" {
  count = local.own_bus && length(var.event_subscriber_accounts) > 0 ? 1 : 0

  statement {
    sid       = "Subscribe"
    actions   = ["events:PutRule", "events:DeleteRule", "events:DescribeRule", "events:PutTargets", "events:RemoveTargets", "events:ListTargetsByRule", "events:EnableRule", "events:DisableRule", "events:TagResource", "events:UntagResource"]
    resources = ["arn:${data.aws_partition.current.partition}:events:${var.region}:*:rule/${var.name}/*"]

    # Its own rules only: not another subscriber's, and not this stack's.
    condition {
      test     = "StringEqualsIfExists"
      variable = "events:creatorAccount"
      values   = ["$${aws:PrincipalAccount}"]
    }

    principals {
      type        = "AWS"
      identifiers = [for account in var.event_subscriber_accounts : "arn:${data.aws_partition.current.partition}:iam::${account}:root"]
    }
  }
}

resource "aws_cloudwatch_event_bus_policy" "subscribers" {
  count = local.own_bus && length(var.event_subscriber_accounts) > 0 ? 1 : 0

  event_bus_name = local.bus_name
  policy         = one(data.aws_iam_policy_document.subscribers[*].json)
}

resource "aws_cloudwatch_event_archive" "events" {
  count = var.event_archive_days > 0 ? 1 : 0

  name             = var.name
  event_source_arn = local.bus_arn
  retention_days   = var.event_archive_days
  # Only what this API published, on a bus it may share.
  event_pattern = jsonencode({ source = ["/${var.name}"] })
}

# --- A log of every event -----------------------------------------------------
# What `task events:tail` follows, and what the scenarios read to see what was
# published. Short-lived: it is for looking, not for keeping.

resource "aws_cloudwatch_log_group" "events" {
  count = var.event_log_days > 0 ? 1 : 0

  name              = "/aws/events/${var.name}"
  retention_in_days = var.event_log_days
}

data "aws_iam_policy_document" "event_log" {
  count = var.event_log_days > 0 ? 1 : 0

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${one(aws_cloudwatch_log_group.events[*].arn)}:*"]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com", "delivery.logs.amazonaws.com"]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "event_log" {
  count = var.event_log_days > 0 ? 1 : 0

  policy_name     = "${var.name}-event-log"
  policy_document = one(data.aws_iam_policy_document.event_log[*].json)
}

resource "aws_cloudwatch_event_rule" "event_log" {
  count = var.event_log_days > 0 ? 1 : 0

  name           = "${var.name}-event-log"
  description    = "Every event ${var.name} publishes, to its log."
  event_bus_name = local.bus_name
  event_pattern  = jsonencode({ source = ["/${var.name}"] })
}

resource "aws_cloudwatch_event_target" "event_log" {
  count = var.event_log_days > 0 ? 1 : 0

  rule           = one(aws_cloudwatch_event_rule.event_log[*].name)
  event_bus_name = local.bus_name
  arn            = one(aws_cloudwatch_log_group.events[*].arn)

  depends_on = [aws_cloudwatch_log_resource_policy.event_log]
}

# --- The forwarder ------------------------------------------------------------

# What the forwarder could not publish, kept with the reason. It is the
# forwarder itself that puts an event here: one bad event must not hold up
# those behind it.
resource "aws_sqs_queue" "unpublished" {
  name                      = "${var.name}-unpublished"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600 # 14 days, the longest
}

data "aws_iam_policy_document" "forwarder" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.forwarder.arn}:*"]
  }

  statement {
    sid       = "ReadTheStream"
    actions   = ["dynamodb:GetRecords", "dynamodb:GetShardIterator", "dynamodb:DescribeStream", "dynamodb:ListStreams"]
    resources = [aws_dynamodb_table.this.stream_arn]
  }

  # An outbox item is removed once it is on the bus, and nothing else is touched.
  statement {
    sid       = "ClearTheOutbox"
    actions   = ["dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.this.arn]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["outbox#*"]
    }
  }

  statement {
    sid       = "Publish"
    actions   = ["events:PutEvents"]
    resources = [local.bus_arn]
  }

  statement {
    sid       = "KeepWhatCouldNotBePublished"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.unpublished.arn]
  }
}

resource "aws_iam_role" "forwarder" {
  name               = "${var.name}-forwarder"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "forwarder" {
  name   = "runtime"
  role   = aws_iam_role.forwarder.id
  policy = data.aws_iam_policy_document.forwarder.json
}

resource "aws_cloudwatch_log_group" "forwarder" {
  name              = "/aws/lambda/${var.name}-forwarder"
  retention_in_days = 14
}

resource "aws_lambda_function" "forwarder" {
  function_name    = "${var.name}-forwarder"
  role             = aws_iam_role.forwarder.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "forwarder.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      TABLE_NAME            = aws_dynamodb_table.this.name
      EVENT_BUS_NAME        = local.bus_name
      UNPUBLISHED_QUEUE_URL = aws_sqs_queue.unpublished.url
    }
  }

  depends_on = [aws_cloudwatch_log_group.forwarder]
}

resource "aws_lambda_event_source_mapping" "outbox" {
  event_source_arn  = aws_dynamodb_table.this.stream_arn
  function_name     = aws_lambda_function.forwarder.arn
  starting_position = "TRIM_HORIZON"
  batch_size        = 10
  # The forwarder puts aside an event the bus will never take, and says where
  # to start again when a failure may pass. Nothing is given up on: a record
  # is offered until it is dealt with or the stream lets go of it, a day on,
  # and the outbox-age alarm says so long before. What is still in the table
  # by then, `task events:retry` publishes.
  function_response_types        = ["ReportBatchItemFailures"]
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = -1

  # Only new outbox items: not the API's own data, and not the removal after.
  filter_criteria {
    filter {
      pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { Keys = { pk = { S = [{ prefix = "outbox#" }] } } } })
    }
  }
}

# --- Alarms -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "outbox_age" {
  alarm_name          = "${var.name}-outbox-age"
  alarm_description   = "Events are waiting in the outbox: the forwarder is failing or cannot keep up, and nothing is being published. Runbook: docs/runbook.md#outbox-age"
  namespace           = "AWS/Lambda"
  metric_name         = "IteratorAge"
  dimensions          = { FunctionName = aws_lambda_function.forwarder.function_name }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 60000 # milliseconds: an event should be on the bus within a minute
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "unpublished" {
  alarm_name          = "${var.name}-unpublished"
  alarm_description   = "An event could not be published and was put aside. It is kept for 14 days. Runbook: docs/runbook.md#unpublished"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.unpublished.name }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "forwarder_errors" {
  alarm_name          = "${var.name}-forwarder-errors"
  alarm_description   = "The forwarder failed outright: an unhandled error, a timeout or out of memory. Its events are tried again. Runbook: docs/runbook.md#forwarder-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.forwarder.function_name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "event_log_failed" {
  count = var.event_log_days > 0 ? 1 : 0

  alarm_name          = "${var.name}-event-delivery-failed"
  alarm_description   = "EventBridge could not deliver events to a target of a rule on the bus. Runbook: docs/runbook.md#event-delivery-failed"
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { EventBusName = local.bus_name, RuleName = one(aws_cloudwatch_event_rule.event_log[*].name) }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# --- Outputs ------------------------------------------------------------------

output "event_bus_name" {
  description = "The bus the API's events are published on. Put a rule on it to subscribe."
  value       = local.bus_name
}

output "event_bus_arn" {
  value = local.bus_arn
}

output "event_log_group" {
  description = "The log group that holds every published event for a short while; empty when there is none."
  value       = var.event_log_days > 0 ? one(aws_cloudwatch_log_group.events[*].name) : ""
}

output "unpublished_queue_url" {
  description = "Where events that could not be published are kept."
  value       = aws_sqs_queue.unpublished.url
}
