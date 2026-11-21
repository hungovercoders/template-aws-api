# Async input: the API takes work from a queue. A message is a CloudEvent the
# AsyncAPI contract describes as a `receive` operation; the consumer function
# - the same bundle as the API, another entry point - holds each one to the
# contract and hands it to the operation's file in src/consumers/.
#
# The queue is the stack's own. Whoever sends to it - another service's bus,
# a topic, a producer with the queue's ARN - is granted that outside this file.

variable "consume_timeout" {
  description = "Seconds the consumer may take over one batch of messages."
  type        = number
  default     = 10
}

variable "consume_visibility_timeout" {
  description = "Seconds a message stays hidden after it is received, before it is offered again. At least consume_timeout; AWS suggests six times it. The local stack shortens it so a scenario need not wait."
  type        = number
  default     = null
}

variable "consume_max_receives" {
  description = "How many times a message is offered before it goes to the dead-letter queue."
  type        = number
  default     = 3
}

variable "consume_fifo" {
  description = "A FIFO queue: messages of one group in order, each exactly once. The default, a standard queue, guarantees neither."
  type        = bool
  default     = false
}

locals {
  consume_name       = "${var.name}-messages"
  consume_suffix     = var.consume_fifo ? ".fifo" : ""
  consume_visibility = coalesce(var.consume_visibility_timeout, 6 * var.consume_timeout)
}

# --- Queues -----------------------------------------------------------------

resource "aws_sqs_queue" "dead_letter" {
  name                      = "${local.consume_name}-dead-letter${local.consume_suffix}"
  fifo_queue                = var.consume_fifo
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600 # 14 days, the longest: time to notice, fix and redrive
}

resource "aws_sqs_queue" "messages" {
  name                       = "${local.consume_name}${local.consume_suffix}"
  fifo_queue                 = var.consume_fifo
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = local.consume_visibility

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = var.consume_max_receives
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dead_letter" {
  queue_url = aws_sqs_queue.dead_letter.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.messages.arn]
  })
}

# --- The consumer -----------------------------------------------------------

data "aws_iam_policy_document" "consumer" {
  # What the API's function may do with the table, the consumer may too.
  source_policy_documents = [data.aws_iam_policy_document.lambda.json]

  statement {
    sid       = "ConsumerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.consumer.arn}:*"]
  }

  statement {
    sid       = "Receive"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
    resources = [aws_sqs_queue.messages.arn]
  }

  # A message that can never succeed is put aside by the consumer itself.
  statement {
    sid       = "DeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letter.arn]
  }
}

resource "aws_iam_role" "consumer" {
  name                 = "${var.name}-consumer"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = local.permissions_boundary
}

resource "aws_iam_role_policy" "consumer" {
  name   = "runtime"
  role   = aws_iam_role.consumer.id
  policy = data.aws_iam_policy_document.consumer.json
}

resource "aws_cloudwatch_log_group" "consumer" {
  name              = "/aws/lambda/${var.name}-consumer"
  retention_in_days = 14
}

resource "aws_lambda_function" "consumer" {
  function_name    = "${var.name}-consumer"
  role             = aws_iam_role.consumer.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "consumer.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = var.consume_timeout

  environment {
    variables = {
      # Names the service on every log line (src/lib/log.ts), in OpenTelemetry's terms.
      OTEL_SERVICE_NAME     = var.name
      TABLE_NAME            = aws_dynamodb_table.this.name
      EVENT_SOURCE          = "/${var.name}"
      DEAD_LETTER_QUEUE_URL = aws_sqs_queue.dead_letter.url
      # How long one delivery may hold its claim on a message: no longer than it can run.
      CONSUME_TIMEOUT = var.consume_timeout
    }
  }

  depends_on = [aws_cloudwatch_log_group.consumer]
}

resource "aws_lambda_event_source_mapping" "messages" {
  event_source_arn = aws_sqs_queue.messages.arn
  function_name    = aws_lambda_function.consumer.arn
  batch_size       = 10
  # One message that fails does not fail the batch it came in.
  function_response_types = ["ReportBatchItemFailures"]
}

# --- Alarms -----------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-queue-age"
  alarm_description   = "Messages are waiting on the queue longer than they should: the consumer is failing, throttled or too slow. Runbook: docs/runbook.md#queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.messages.name }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2 * local.consume_visibility * var.consume_max_receives
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name          = "${var.name}-dead-letters"
  alarm_description   = "A message could not be handled and was put on the dead-letter queue. It is kept for 14 days. Runbook: docs/runbook.md#dead-letters"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letter.name }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "consumer_errors" {
  alarm_name          = "${var.name}-consumer-errors"
  alarm_description   = "The consumer failed outright: an unhandled error, a timeout or out of memory. Its messages are offered again. Runbook: docs/runbook.md#consumer-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "consumer_throttles" {
  alarm_name          = "${var.name}-consumer-throttles"
  alarm_description   = "The consumer was throttled: messages wait while the account's concurrency is used elsewhere. Runbook: docs/runbook.md#consumer-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  dimensions          = { FunctionName = aws_lambda_function.consumer.function_name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# --- Outputs ----------------------------------------------------------------

output "queue_url" {
  description = "Where messages for this API are sent."
  value       = aws_sqs_queue.messages.url
}

output "queue_arn" {
  description = "The queue's ARN: what a sender's policy, or a subscription from a bus or topic, names."
  value       = aws_sqs_queue.messages.arn
}

output "dead_letter_queue_url" {
  description = "Where messages that could not be handled are kept."
  value       = aws_sqs_queue.dead_letter.url
}
