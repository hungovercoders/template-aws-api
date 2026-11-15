# The events as data: every event the API publishes is also kept in S3, where
# analysts and other systems read it long after it was sent. A rule on the
# bus sends each to Firehose, which writes it as one line of JSON -
# the whole CloudEvent - under
#   <prefix>type=<event type>/dt=<date>/
#
# What is kept, where, for how long and how fresh is the data contract's to
# say (specs/datacontract.yaml), and is read from it here, so the contract
# and the infrastructure cannot disagree. An API without a data contract
# keeps nothing: none of this is created.

variable "data_server" {
  description = "Which server of the data contract this stack is: its bucket and prefix are where the events are kept. A second stack of the same API (a test environment) needs a server of its own in the contract."
  type        = string
  default     = "production"
}

variable "data_buffer_seconds" {
  description = "How long Firehose gathers events before it writes a file. Longer means fewer, larger files; it must be well inside the freshness the data contract promises."
  type        = number
  default     = 300
}

variable "data_compression" {
  description = "How Firehose writes each file: UNCOMPRESSED, so the data can be tested and read where it is, or GZIP, about a fifth of the size, for a volume where storage matters more - the data contract test then has to unpack a copy to read it."
  type        = string
  default     = "UNCOMPRESSED"

  validation {
    condition     = contains(["UNCOMPRESSED", "GZIP"], var.data_compression)
    error_message = "data_compression is UNCOMPRESSED or GZIP."
  }
}

variable "data_reader_accounts" {
  description = "AWS account ids that may read the data."
  type        = list(string)
  default     = []
}

locals {
  data_contract_file = "${path.module}/../specs/datacontract.yaml"
  data_contract      = fileexists(local.data_contract_file) ? yamldecode(file(local.data_contract_file)) : null
  data_servers       = [for server in try(local.data_contract.servers, []) : server if try(server.server, "") == var.data_server]
  data_enabled       = length(local.data_servers) > 0
  data_count         = local.data_enabled ? 1 : 0

  # s3://<bucket>/<prefix>/ - `task data:check` holds the contract to this form.
  data_location = local.data_enabled ? regex("^s3://(?P<bucket>[^/]+)/(?P<prefix>.*)$", local.data_servers[0].location) : { bucket = "", prefix = "" }

  data_sla       = { for entry in try(local.data_contract.slaProperties, []) : entry.property => entry }
  data_retention = local.data_enabled ? local.data_sla["retention"].value * (local.data_sla["retention"].unit == "y" ? 365 : 1) : 0
  data_latency   = local.data_enabled ? local.data_sla["latency"].value * { s = 1, m = 60, h = 3600, d = 86400 }[local.data_sla["latency"].unit] : 0
}

provider "awscc" {
  region = var.region
}

# --- The bucket ---------------------------------------------------------------
# Made through Cloud Control with nothing but its name: the plain
# aws_s3_bucket reads the bucket's tags through S3 Control, which AWS
# Emulator does not serve. Everything else about it is the plain resources
# below, so the same definition applies to the emulator and to AWS.
#
# A bucket that holds events is never deleted by a deploy: renaming it in
# the contract, or removing the contract, fails until it has been emptied.
# That is deliberate - the data outlives a mistake in a pull request.

resource "awscc_s3_bucket" "data" {
  count = local.data_count

  bucket_name = local.data_location.bucket
  # Cloud Control has no default tags: they are given by name.
  tags = [for key, value in local.tags : { key = key, value = value }]
}

resource "aws_s3_bucket_public_access_block" "data" {
  count = local.data_count

  bucket                  = one(awscc_s3_bucket.data[*].id)
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  count = local.data_count

  bucket = one(awscc_s3_bucket.data[*].id)

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The contract's retention: an event is deleted when it is that old.
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  count = local.data_count

  bucket = one(awscc_s3_bucket.data[*].id)

  rule {
    id     = "retention"
    status = "Enabled"

    filter {}

    expiration {
      days = local.data_retention
    }
  }
}

data "aws_iam_policy_document" "data_readers" {
  count = local.data_enabled && length(var.data_reader_accounts) > 0 ? 1 : 0

  statement {
    sid       = "Read"
    actions   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
    resources = [one(awscc_s3_bucket.data[*].arn), "${one(awscc_s3_bucket.data[*].arn)}/${local.data_location.prefix}*"]

    principals {
      type        = "AWS"
      identifiers = [for account in var.data_reader_accounts : "arn:${data.aws_partition.current.partition}:iam::${account}:root"]
    }
  }
}

resource "aws_s3_bucket_policy" "data_readers" {
  count = local.data_enabled && length(var.data_reader_accounts) > 0 ? 1 : 0

  bucket = one(awscc_s3_bucket.data[*].id)
  policy = one(data.aws_iam_policy_document.data_readers[*].json)

  depends_on = [aws_s3_bucket_public_access_block.data]
}

# --- Firehose -----------------------------------------------------------------

data "aws_caller_identity" "data" {}

data "aws_iam_policy_document" "data_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["firehose.amazonaws.com", "events.amazonaws.com"]
    }

    # Only for this account's rule and stream: never as another account's deputy.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.data.account_id]
    }
  }
}

data "aws_iam_policy_document" "data" {
  count = local.data_count

  statement {
    sid       = "Write"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [one(awscc_s3_bucket.data[*].arn), "${one(awscc_s3_bucket.data[*].arn)}/*"]
  }

  statement {
    sid       = "Deliver"
    actions   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = ["arn:${data.aws_partition.current.partition}:firehose:${var.region}:${data.aws_caller_identity.data.account_id}:deliverystream/${var.name}-data"]
  }
}

# One role for the two hops: the rule puts events on the stream, the stream writes them to the bucket.
resource "aws_iam_role" "data" {
  count = local.data_count

  name               = "${var.name}-data"
  assume_role_policy = data.aws_iam_policy_document.data_assume.json
}

resource "aws_iam_role_policy" "data" {
  count = local.data_count

  name   = "data"
  role   = one(aws_iam_role.data[*].id)
  policy = one(data.aws_iam_policy_document.data[*].json)
}

resource "aws_kinesis_firehose_delivery_stream" "data" {
  count = local.data_count

  name        = "${var.name}-data"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = one(aws_iam_role.data[*].arn)
    bucket_arn = one(awscc_s3_bucket.data[*].arn)
    # The event's type and the day it arrived are its place.
    prefix = "${local.data_location.prefix}type=!{partitionKeyFromQuery:type}/dt=!{timestamp:yyyy-MM-dd}/"
    # What cannot be placed - not JSON, or with no type - is kept apart, never dropped.
    error_output_prefix = "errors/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/"
    compression_format  = var.data_compression
    buffering_interval  = var.data_buffer_seconds
    buffering_size      = 64

    dynamic_partitioning_configuration {
      enabled = true
    }

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

      # One event per line.
      processors {
        type = "AppendDelimiterToRecord"
      }
    }
  }

  depends_on = [aws_iam_role_policy.data]

  lifecycle {
    # An event waits in the buffer before it is written, so the buffer has to fit inside what readers were promised.
    precondition {
      condition     = var.data_buffer_seconds < local.data_latency
      error_message = "data_buffer_seconds must be less than the data contract's latency (slaProperties): an event is only in S3 once the buffer has been written."
    }
  }
}

# --- From the bus to the stream -----------------------------------------------

resource "aws_cloudwatch_event_rule" "data" {
  count = local.data_count

  name           = "${var.name}-data"
  description    = "Every event ${var.name} publishes, to S3 as data."
  event_bus_name = local.bus_name
  event_pattern  = jsonencode({ source = ["/${var.name}"] })
}

resource "aws_cloudwatch_event_target" "data" {
  count = local.data_count

  rule           = one(aws_cloudwatch_event_rule.data[*].name)
  event_bus_name = local.bus_name
  arn            = one(aws_kinesis_firehose_delivery_stream.data[*].arn)
  role_arn       = one(aws_iam_role.data[*].arn)
  # The CloudEvent itself, without the bus's envelope.
  input_path = "$.detail"
}

# --- Alarms -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "data_delivery" {
  count = local.data_count

  alarm_name          = "${var.name}-data-delivery"
  alarm_description   = "Firehose is failing to write events to S3: they are held for a day and then lost as data. Runbook: docs/data.md#data-delivery"
  namespace           = "AWS/Firehose"
  metric_name         = "DeliveryToS3.Success"
  dimensions          = { DeliveryStreamName = one(aws_kinesis_firehose_delivery_stream.data[*].name) }
  statistic           = "Minimum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "data_freshness" {
  count = local.data_count

  alarm_name          = "${var.name}-data-freshness"
  alarm_description   = "The oldest event not yet in S3 is older than the data contract promises. Runbook: docs/data.md#data-freshness"
  namespace           = "AWS/Firehose"
  metric_name         = "DeliveryToS3.DataFreshness"
  dimensions          = { DeliveryStreamName = one(aws_kinesis_firehose_delivery_stream.data[*].name) }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.data_latency # seconds, from the contract's latency
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "data_rule" {
  count = local.data_count

  alarm_name          = "${var.name}-data-rule"
  alarm_description   = "The bus could not hand events to Firehose: they were published but are not being kept. Runbook: docs/data.md#data-rule"
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { EventBusName = local.bus_name, RuleName = one(aws_cloudwatch_event_rule.data[*].name) }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

# --- Outputs ------------------------------------------------------------------

output "data_bucket" {
  description = "The bucket the events are kept in; empty when the API has no data contract."
  value       = local.data_location.bucket
}

output "data_prefix" {
  description = "The prefix under which they are kept, as type=<event type>/dt=<date>/."
  value       = local.data_location.prefix
}

output "data_compression" {
  description = "How the files are written: UNCOMPRESSED or GZIP."
  value       = local.data_enabled ? var.data_compression : ""
}

output "data_stream" {
  description = "The Firehose stream that writes them."
  value       = local.data_enabled ? "${var.name}-data" : ""
}
