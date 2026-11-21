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

# The API's service level objectives (specs/slos/*.yaml, OpenSLO, held to the shapes below by
# `task slo:check`) set these alarms' thresholds. Without them the template's own stand.
locals {
  slos = [for name in sort(fileset("${path.module}/${var.specs}", "slos/*.yaml")) : yamldecode(file("${path.module}/${var.specs}/${name}"))]

  # Availability: the share of requests answered 5xx may not pass 1 - target.
  availability = one([for slo in local.slos : {
    name   = slo.metadata.name
    target = slo.spec.objectives[0].target
  } if try(slo.spec.indicator.spec.ratioMetric, null) != null])

  # Latency: the percentile `stat` may not pass `value` milliseconds - for the whole API, or
  # for the one operation its `operation` label names.
  latency = [for slo in local.slos : {
    name         = slo.metadata.name
    stat         = slo.spec.indicator.spec.thresholdMetric.metricSource.spec.stat
    milliseconds = slo.spec.objectives[0].value
    operation    = try(slo.metadata.labels.operation, null)
  } if try(slo.spec.indicator.spec.thresholdMetric, null) != null]
  api_latency = one([for slo in local.latency : slo if slo.operation == null])

  # Each operationId's route, so an operation's SLO is measured on its route alone.
  operation_routes = merge([
    for contract in local.contracts : merge([
      for path, item in try(contract.paths, {}) : {
        for method, operation in item : operation.operationId => "${upper(method)} ${path}" if contains(local.methods, method) && try(operation.operationId, null) != null
      }
    ]...)
  ]...)
  operation_latency = { for slo in local.latency : slo.operation => merge(slo, { route = local.operation_routes[slo.operation] }) if slo.operation != null }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name = "${var.name}-api-5xx"
  alarm_description = (local.availability == null
    ? "Callers received a 5xx: the API failed, or API Gateway could not reach the Lambda. Runbook: docs/runbook.md#api-5xx"
    : "Over ${format("%g", (1 - local.availability.target) * 100)}% of requests were answered 5xx in 5 minutes, against the ${local.availability.name} SLO (specs/slos). Runbook: docs/runbook.md#api-5xx"
  )
  evaluation_periods  = 1
  comparison_operator = local.availability == null ? "GreaterThanOrEqualToThreshold" : "GreaterThanThreshold"
  threshold           = local.availability == null ? 1 : 1 - local.availability.target
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action

  # Without an availability SLO: any 5xx.
  namespace   = local.availability == null ? "AWS/ApiGateway" : null
  metric_name = local.availability == null ? "5xx" : null
  dimensions  = local.availability == null ? { ApiId = aws_apigatewayv2_api.this.id } : null
  statistic   = local.availability == null ? "Sum" : null
  period      = local.availability == null ? local.alarm_period : null

  # With one: the share of requests answered 5xx.
  dynamic "metric_query" {
    for_each = local.availability == null ? [] : [1]
    content {
      id          = "share"
      expression  = "IF(requests > 0, errors / requests, 0)"
      label       = "Share of requests answered 5xx"
      return_data = true
    }
  }

  dynamic "metric_query" {
    for_each = local.availability == null ? {} : { errors = "5xx", requests = "Count" }
    content {
      id = metric_query.key
      metric {
        namespace   = "AWS/ApiGateway"
        metric_name = metric_query.value
        dimensions  = { ApiId = aws_apigatewayv2_api.this.id }
        stat        = "Sum"
        period      = local.alarm_period
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name = "${var.name}-api-latency"
  alarm_description = (local.api_latency == null
    ? "The slowest 1% of requests took over 3 seconds, for 15 minutes. Runbook: docs/runbook.md#api-latency"
    : "Requests' ${local.api_latency.stat} latency was over ${local.api_latency.milliseconds} ms for 15 minutes, against the ${local.api_latency.name} SLO (specs/slos). Runbook: docs/runbook.md#api-latency"
  )
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id }
  extended_statistic  = local.api_latency == null ? "p99" : local.api_latency.stat
  period              = local.alarm_period
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.api_latency == null ? 3000 : local.api_latency.milliseconds
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# An operation's own latency SLO, measured on its route (its route's detailed metrics are on).
resource "aws_cloudwatch_metric_alarm" "operation_latency" {
  for_each = local.operation_latency

  alarm_name          = "${var.name}-latency-${each.key}"
  alarm_description   = "${each.value.route}'s ${each.value.stat} latency was over ${each.value.milliseconds} ms for 15 minutes, against the ${each.value.name} SLO (specs/slos). Runbook: docs/runbook.md#api-latency"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id, Stage = aws_apigatewayv2_stage.default.name, Route = each.value.route }
  extended_statistic  = each.value.stat
  period              = local.alarm_period
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.milliseconds
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
