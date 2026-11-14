# The probe behind issue #33: what AWS Emulator can run for SQS, DynamoDB
# Streams, EventBridge, Pipes, Firehose, S3 and CloudWatch alarms. Not part of
# the skeleton and not applied by any task. Re-run it when EMULATOR_VERSION is
# raised, to see which workarounds are still needed:
#   1. start the emulator and export the variables local/stack.mjs sets
#      (AWS_ENDPOINT_URL, AWS_SHARED_CREDENTIALS_FILE, AWS_CONFIG_FILE,
#      AWS_CA_BUNDLE, ...), with the real AWS credentials unset
#   2. terraform init && terraform apply    (about 80s; start a new emulator
#      for each apply - a second apply fails on the on-demand table)
#   3. write items with pk "outbox#..." or "pipe#...", send messages to the
#      probe-in queue (a body containing "fail" is rejected), put events with
#      source "probe" on the probe bus, then look at the probe-capture queue,
#      the probe-events bucket and the alarms. duck.py queries the bucket.
terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
    awscc   = { source = "hashicorp/awscc", version = "~> 1.0" }
  }
}
variable "s3control" { default = "" }
provider "aws" {
  region = "us-east-1"
  dynamic "endpoints" {
    for_each = var.s3control == "" ? [] : [1]
    content { s3control = var.s3control }
  }
}
provider "awscc" { region = "us-east-1" }
variable "pipes" { default = true }
variable "partitioned" { default = true }
locals { n = "probe" }

data "archive_file" "fn" {
  type        = "zip"
  source_dir  = "${path.module}/fn"
  output_path = "${path.module}/fn.zip"
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "firehose.amazonaws.com", "events.amazonaws.com", "pipes.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "all" {
  name               = "${local.n}-all"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}
resource "aws_iam_role_policy" "all" {
  role   = aws_iam_role.all.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
}

# --- DynamoDB: stream, TTL
resource "aws_dynamodb_table" "t" {
  name             = local.n
  billing_mode     = "PAY_PER_REQUEST"
  hash_key         = "pk"
  range_key        = "sk"
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
  lifecycle { ignore_changes = [on_demand_throughput] }
}
resource "aws_cloudwatch_log_resource_policy" "events" {
  policy_name     = "probe-events"
  policy_document = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = ["events.amazonaws.com", "delivery.logs.amazonaws.com"] }, Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.events.arn}:*" }] })
}

# --- Lambdas
resource "aws_lambda_function" "fn" {
  for_each         = toset(["consumer", "forwarder", "target"])
  function_name    = "${local.n}-${each.key}"
  role             = aws_iam_role.all.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.${each.key}"
  filename         = data.archive_file.fn.output_path
  source_code_hash = data.archive_file.fn.output_base64sha256
  timeout          = 10
  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.t.name, BUS_NAME = aws_cloudwatch_event_bus.bus.name }
  }
}

# --- SQS: queue, DLQ, redrive, event source mapping with partial batch responses
resource "aws_sqs_queue" "dlq" {
  name                    = "${local.n}-dlq"
  sqs_managed_sse_enabled = true
}
resource "aws_sqs_queue" "in" {
  name                       = "${local.n}-in"
  visibility_timeout_seconds = 30
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 2 })
}
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url            = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({ redrivePermission = "byQueue", sourceQueueArns = [aws_sqs_queue.in.arn] })
}
resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn        = aws_sqs_queue.in.arn
  function_name           = aws_lambda_function.fn["consumer"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}
resource "aws_lambda_event_source_mapping" "stream" {
  event_source_arn               = aws_dynamodb_table.t.stream_arn
  function_name                  = aws_lambda_function.fn["forwarder"].arn
  starting_position              = "TRIM_HORIZON"
  batch_size                     = 10
  maximum_retry_attempts         = 2
  bisect_batch_on_function_error = true
  destination_config {
    on_failure { destination_arn = aws_sqs_queue.dlq.arn }
  }
}

# --- EventBridge: bus, archive, rule, four kinds of target
resource "aws_cloudwatch_event_bus" "bus" { name = local.n }
resource "aws_cloudwatch_event_archive" "a" {
  name             = local.n
  event_source_arn = aws_cloudwatch_event_bus.bus.arn
  retention_days   = 7
}
resource "aws_cloudwatch_event_rule" "all" {
  name           = "${local.n}-all"
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  event_pattern  = jsonencode({ source = ["probe"], "detail-type" = [{ prefix = "probe." }] })
}
resource "aws_sqs_queue" "capture" { name = "${local.n}-capture" }
resource "aws_sqs_queue_policy" "capture" {
  queue_url = aws_sqs_queue.capture.id
  policy    = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sqs:SendMessage", Resource = aws_sqs_queue.capture.arn }] })
}
resource "aws_cloudwatch_event_target" "sqs" {
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  arn            = aws_sqs_queue.capture.arn
}
resource "aws_cloudwatch_event_target" "lambda" {
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  arn            = aws_lambda_function.fn["target"].arn
}
resource "aws_lambda_permission" "events" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["target"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.all.arn
}
resource "aws_cloudwatch_log_group" "events" {
  name              = "/aws/events/${local.n}"
  retention_in_days = 1
}
resource "aws_cloudwatch_event_target" "logs" {
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  arn            = aws_cloudwatch_log_group.events.arn
}
resource "aws_cloudwatch_event_target" "firehose" {
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  arn            = aws_kinesis_firehose_delivery_stream.plain.arn
  role_arn       = aws_iam_role.all.arn
  input_path     = "$.detail"
}
# The rule also matches the pipe's events, whose detail is a raw stream record
# with no "type". They are how the probe shows the error prefix working.
resource "aws_cloudwatch_event_target" "firehose_partitioned" {
  count          = var.partitioned ? 1 : 0
  rule           = aws_cloudwatch_event_rule.all.name
  event_bus_name = aws_cloudwatch_event_bus.bus.name
  arn            = aws_kinesis_firehose_delivery_stream.partitioned[0].arn
  role_arn       = aws_iam_role.all.arn
  input_path     = "$.detail"
}

# --- Pipes: stream -> bus
resource "aws_pipes_pipe" "p" {
  count    = var.pipes ? 1 : 0
  name     = local.n
  role_arn = aws_iam_role.all.arn
  source   = aws_dynamodb_table.t.stream_arn
  target   = aws_cloudwatch_event_bus.bus.arn
  source_parameters {
    dynamodb_stream_parameters {
      starting_position = "TRIM_HORIZON"
      batch_size        = 1
    }
    filter_criteria {
      filter { pattern = jsonencode({ eventName = ["INSERT"], dynamodb = { NewImage = { pk = { S = [{ prefix = "pipe#" }] } } } }) }
    }
  }
  target_parameters {
    eventbridge_event_bus_parameters {
      source      = "probe"
      detail_type = "probe.pipe.v1"
    }
  }
}

# --- S3 + Firehose
resource "awscc_s3_bucket" "b" {
  bucket_name = "${local.n}-events"
}
resource "aws_s3_bucket_public_access_block" "b" {
  bucket                  = awscc_s3_bucket.b.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "b" {
  bucket = awscc_s3_bucket.b.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "b" {
  bucket = awscc_s3_bucket.b.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    expiration { days = 365 }
  }
}
resource "aws_kinesis_firehose_delivery_stream" "plain" {
  name        = "${local.n}-plain"
  destination = "extended_s3"
  extended_s3_configuration {
    role_arn            = aws_iam_role.all.arn
    bucket_arn          = awscc_s3_bucket.b.arn
    prefix              = "plain/dt=!{timestamp:yyyy-MM-dd}/"
    error_output_prefix = "errors/plain/!{firehose:error-output-type}/"
    compression_format  = "GZIP"
    buffering_interval  = 0
    buffering_size      = 1
    processing_configuration {
      enabled = true
      processors {
        type = "AppendDelimiterToRecord"
      }
    }
  }
}
resource "aws_kinesis_firehose_delivery_stream" "partitioned" {
  count       = var.partitioned ? 1 : 0
  name        = "${local.n}-partitioned"
  destination = "extended_s3"
  extended_s3_configuration {
    role_arn            = aws_iam_role.all.arn
    bucket_arn          = awscc_s3_bucket.b.arn
    prefix              = "events/type=!{partitionKeyFromQuery:type}/dt=!{timestamp:yyyy-MM-dd}/"
    error_output_prefix = "errors/partitioned/!{firehose:error-output-type}/"
    compression_format  = "GZIP"
    buffering_interval  = 0
    buffering_size      = 64
    dynamic_partitioning_configuration { enabled = true }
    processing_configuration {
      enabled = true
      processors {
        type = "MetadataExtraction"
        parameters {
          parameter_name  = "JsonParsingEngine"
          parameter_value = "JQ-1.6"
        }
        parameters {
          parameter_name  = "MetadataExtractionQuery"
          parameter_value = "{type:.type}"
        }
      }
      processors {
        type = "AppendDelimiterToRecord"
      }
    }
  }
}

# --- Alarms the later issues need
locals {
  alarms = {
    queue-age      = ["AWS/SQS", "ApproximateAgeOfOldestMessage", "Maximum", { QueueName = aws_sqs_queue.in.name }]
    dlq-not-empty  = ["AWS/SQS", "ApproximateNumberOfMessagesVisible", "Maximum", { QueueName = aws_sqs_queue.dlq.name }]
    iterator-age   = ["AWS/Lambda", "IteratorAge", "Maximum", { FunctionName = aws_lambda_function.fn["forwarder"].function_name }]
    rule-failed    = ["AWS/Events", "FailedInvocations", "Sum", { RuleName = aws_cloudwatch_event_rule.all.name, EventBusName = aws_cloudwatch_event_bus.bus.name }]
    firehose-s3    = ["AWS/Firehose", "DeliveryToS3.Success", "Minimum", { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.plain.name }, "LessThanThreshold", 1]
    firehose-fresh = ["AWS/Firehose", "DeliveryToS3.DataFreshness", "Maximum", { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.plain.name }]
  }
}
resource "aws_cloudwatch_metric_alarm" "a" {
  for_each    = local.alarms
  alarm_name  = "${local.n}-${each.key}"
  namespace   = each.value[0]
  metric_name = each.value[1]
  statistic   = each.value[2]
  dimensions  = each.value[3]
  # DeliveryToS3.Success is 1 for a delivery that worked, so that alarm is "below 1".
  comparison_operator = try(each.value[4], "GreaterThanThreshold")
  threshold           = try(each.value[5], 0)
  period              = 60
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
}

output "in" { value = aws_sqs_queue.in.url }
output "dlq" { value = aws_sqs_queue.dlq.url }
output "capture" { value = aws_sqs_queue.capture.url }
output "stream" { value = aws_dynamodb_table.t.stream_arn }
