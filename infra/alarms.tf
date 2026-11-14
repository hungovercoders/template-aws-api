# Standard alerting: the alarms every API needs, created with the stack. Each
# one notifies a single SNS topic when it fires and again when it recovers.
#
# Thresholds are deliberately strict - a new API should be quiet. Loosen one
# here when you understand why it fires, rather than removing it.

locals {
  alarm_period = 300 # seconds; alarms evaluate five-minute windows

  # Your own topic if you supplied one, else the one created below.
  alarm_topic  = var.alarm_topic_arn != "" ? var.alarm_topic_arn : one(aws_sns_topic.alarms[*].arn)
  alarm_action = [local.alarm_topic]
}

# --- Where alarms go ------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  count = var.alarm_topic_arn == "" ? 1 : 0

  name = "${var.name}-alarms"
}

# The address must confirm the subscription from the email AWS sends it.
resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email != "" ? 1 : 0

  topic_arn = local.alarm_topic
  protocol  = "email"
  endpoint  = var.alarm_email
}

# --- Lambda ---------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${var.name}-lambda-errors"
  alarm_description   = "The Lambda failed: an unhandled error, a timeout or out of memory. Find the request in its logs by request_id. Runbook: docs/runbook.md#lambda-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${var.name}-lambda-throttles"
  alarm_description   = "Requests were refused because the Lambda hit its concurrency limit. Runbook: docs/runbook.md#lambda-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "lambda_duration" {
  alarm_name          = "${var.name}-lambda-duration"
  alarm_description   = "The slowest 1% of invocations are within 20% of the Lambda timeout; timeouts are next. Runbook: docs/runbook.md#lambda-duration"
  namespace           = "AWS/Lambda"
  metric_name         = "Duration"
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  extended_statistic  = "p99"
  period              = local.alarm_period
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = aws_lambda_function.api.timeout * 1000 * 0.8
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# --- API Gateway ----------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "Callers received a 5xx: the API failed, or API Gateway could not reach the Lambda. Runbook: docs/runbook.md#api-5xx"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${var.name}-api-latency"
  alarm_description   = "The slowest 1% of requests took over 3 seconds, for 15 minutes. Runbook: docs/runbook.md#api-latency"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id }
  extended_statistic  = "p99"
  period              = local.alarm_period
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 3000
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# --- DynamoDB -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "table_throttles" {
  alarm_name          = "${var.name}-table-throttles"
  alarm_description   = "DynamoDB throttled reads or writes on the table; the SDK retries, so callers see slowness before errors. Runbook: docs/runbook.md#table-throttles"
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action

  metric_query {
    id          = "throttles"
    expression  = "reads + writes"
    label       = "Throttled reads and writes"
    return_data = true
  }

  metric_query {
    id = "reads"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "ReadThrottleEvents"
      dimensions  = { TableName = aws_dynamodb_table.this.name }
      stat        = "Sum"
      period      = local.alarm_period
    }
  }

  metric_query {
    id = "writes"
    metric {
      namespace   = "AWS/DynamoDB"
      metric_name = "WriteThrottleEvents"
      dimensions  = { TableName = aws_dynamodb_table.this.name }
      stat        = "Sum"
      period      = local.alarm_period
    }
  }
}
