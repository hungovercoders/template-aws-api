# The events as data: every event the API publishes is also kept in S3, where
# analysts and other systems read it long after it was sent. For each live
# major of the data contract (specs/contracts/datacontract.v<N>.yaml) a rule on the bus
# sends every event to that major's Firehose stream, which writes it as one
# line of JSON - the whole CloudEvent - under that major's location:
#   <prefix ending /v<N>/>type=<event type>/dt=<date>/
# so a new major's readers and an old one's are served side by side, from one
# bucket. Once a day a compactor turns each of the last few days into Parquet,
# under the major's second server, <server>-parquet:
#   <its prefix, ending /v<N>/>type=<event type>/dt=<the day it happened>/events.parquet
# one file per event type and day, typed by the contract, each event once. The
# raw JSON is kept for its server's own retention (customProperties, 7 years when
# the contract does not say); the Parquet for the contract's retention.
#
# What is kept, where, for how long and how fresh is each data contract's to
# say, and is read from it here, so the contracts and the infrastructure
# cannot disagree. An API without a data contract keeps nothing: none of this
# is created.

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
  # Every live major, by name (v0, v1, ...), with this stack's server in it.
  data_contracts = {
    for name in sort(fileset("${path.module}/${var.specs}", "contracts/datacontract.v*.yaml")) :
    regex("^contracts/datacontract\\.(v[0-9]+)\\.yaml$", name)[0] => yamldecode(file("${path.module}/${var.specs}/${name}"))
  }
  data_majors = {
    for major, contract in local.data_contracts : major => {
      server  = [for server in try(contract.servers, []) : server if try(server.server, "") == var.data_server][0]
      parquet = [for server in try(contract.servers, []) : server if try(server.server, "") == "${var.data_server}-parquet"]
      sla     = { for entry in try(contract.slaProperties, []) : entry.property => entry }
    } if length([for server in try(contract.servers, []) : server if try(server.server, "") == var.data_server]) > 0
  }
  data_enabled = length(local.data_majors) > 0
  data_count   = local.data_enabled ? 1 : 0

  # s3://<bucket>/<prefix>/ - `task data:check` holds each contract to this form, and every major to one bucket.
  data_locations = { for major, entry in local.data_majors : major => regex("^s3://(?P<bucket>[^/]+)/(?P<prefix>.*)$", entry.server.location) }
  # `task data:check` holds every major to a <server>-parquet server in the same bucket.
  data_parquet = { for major, entry in local.data_majors : major => regex("^s3://(?P<bucket>[^/]+)/(?P<prefix>.*)$", one(entry.parquet).location) }
  data_buckets = distinct(concat([for location in values(local.data_locations) : location.bucket], [for location in values(local.data_parquet) : location.bucket]))
  data_bucket  = local.data_enabled ? local.data_buckets[0] : ""

  # yamldecode reads a bare `unit: y` as YAML 1.1's boolean true, so years are "y" or true.
  data_retention = { for major, entry in local.data_majors : major => entry.sla["retention"].value * (contains(["y", "true"], tostring(entry.sla["retention"].unit)) ? 365 : 1) }
  # The raw JSON's own retention, on its server: an ISO 8601 duration (P7Y, P30D), P7Y when unsaid.
  # `task data:check` holds it to that form and to at least P7D, so each day is compacted first.
  data_raw_retention = {
    for major, entry in local.data_majors : major => (
      tonumber(regex("^P([0-9]+)[YD]$", local.data_raw_duration[major])[0]) * (endswith(local.data_raw_duration[major], "Y") ? 365 : 1)
    )
  }
  data_raw_duration = {
    for major, entry in local.data_majors : major => try([for custom in entry.server.customProperties : custom.value if custom.property == "retention"][0], "P7Y")
  }
  data_latency = { for major, entry in local.data_majors : major => entry.sla["latency"].value * { s = 1, m = 60, h = 3600, d = 86400 }[entry.sla["latency"].unit] }
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

  bucket_name = local.data_bucket
  # Cloud Control has no default tags: they are given by name.
  tags = [for key, value in local.tags : { key = key, value = value }]

  lifecycle {
    precondition {
      condition     = length(local.data_buckets) == 1
      error_message = "Every major of the data contract keeps its data in the same bucket, under its own /v<N>/ prefix."
    }
  }
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

# Under each major's prefixes: the raw JSON is deleted after its server's retention, the
# Parquet after the contract's retention.
resource "aws_s3_bucket_lifecycle_configuration" "data" {
  count = local.data_count

  bucket = one(awscc_s3_bucket.data[*].id)

  dynamic "rule" {
    for_each = local.data_locations

    content {
      id     = "retention-${rule.key}"
      status = "Enabled"

      filter {
        prefix = rule.value.prefix
      }

      expiration {
        days = local.data_raw_retention[rule.key]
      }
    }
  }

  dynamic "rule" {
    for_each = local.data_parquet

    content {
      id     = "retention-${rule.key}-parquet"
      status = "Enabled"

      filter {
        prefix = rule.value.prefix
      }

      expiration {
        days = local.data_retention[rule.key]
      }
    }
  }

  # What could not be placed is kept as long as the longest promise.
  rule {
    id     = "retention-errors"
    status = "Enabled"

    filter {
      prefix = "errors/"
    }

    expiration {
      days = max(concat([1], values(local.data_retention), values(local.data_raw_retention))...)
    }
  }
}

data "aws_iam_policy_document" "data_readers" {
  count = local.data_enabled && length(var.data_reader_accounts) > 0 ? 1 : 0

  statement {
    sid       = "Read"
    actions   = ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"]
    resources = concat([one(awscc_s3_bucket.data[*].arn)], [for location in concat(values(local.data_locations), values(local.data_parquet)) : "${one(awscc_s3_bucket.data[*].arn)}/${location.prefix}*"])

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
    resources = ["arn:${data.aws_partition.current.partition}:firehose:${var.region}:${data.aws_caller_identity.data.account_id}:deliverystream/${var.name}-data-*"]
  }
}

# One role for the two hops of every major: a rule puts events on its stream, the stream writes them to the bucket.
resource "aws_iam_role" "data" {
  count = local.data_count

  name                 = "${var.name}-data"
  assume_role_policy   = data.aws_iam_policy_document.data_assume.json
  permissions_boundary = local.permissions_boundary
}

resource "aws_iam_role_policy" "data" {
  count = local.data_count

  name   = "data"
  role   = one(aws_iam_role.data[*].id)
  policy = one(data.aws_iam_policy_document.data[*].json)
}

resource "aws_kinesis_firehose_delivery_stream" "data" {
  for_each = local.data_majors

  name        = "${var.name}-data-${each.key}"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn   = one(aws_iam_role.data[*].arn)
    bucket_arn = one(awscc_s3_bucket.data[*].arn)
    # The major's location, then the event's type and the day it arrived, are its place.
    prefix = "${local.data_locations[each.key].prefix}type=!{partitionKeyFromQuery:type}/dt=!{timestamp:yyyy-MM-dd}/"
    # What cannot be placed - not JSON, or with no type - is kept apart, never dropped.
    error_output_prefix = "errors/${each.key}/!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/"
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
      condition     = var.data_buffer_seconds < local.data_latency[each.key]
      error_message = "data_buffer_seconds must be less than the latency (slaProperties) of data contract ${each.key}: an event is only in S3 once the buffer has been written."
    }
  }
}

# --- From the bus to the stream -----------------------------------------------

resource "aws_cloudwatch_event_rule" "data" {
  for_each = local.data_majors

  name           = "${var.name}-data-${each.key}"
  description    = "Every event ${var.name} publishes, to S3 as data under data contract ${each.key}."
  event_bus_name = local.bus_name
  event_pattern  = jsonencode({ source = ["/${var.name}"] })
}

resource "aws_cloudwatch_event_target" "data" {
  for_each = local.data_majors

  rule           = aws_cloudwatch_event_rule.data[each.key].name
  event_bus_name = local.bus_name
  arn            = aws_kinesis_firehose_delivery_stream.data[each.key].arn
  role_arn       = one(aws_iam_role.data[*].arn)
  # The CloudEvent itself, without the bus's envelope.
  input_path = "$.detail"
}

# --- The daily compaction to Parquet -------------------------------------------
# One function for every major (src/compactor.ts), started by a schedule a little
# after midnight UTC, and by `task data:compact`. Its role is assumed by the
# function to read the raw JSON and write the Parquet, and by the schedule to start it.

locals {
  data_compactor = "${var.name}-data-compactor"
}

data "aws_iam_policy_document" "data_compactor_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "scheduler.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "data_compactor" {
  count = local.data_count

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${one(aws_cloudwatch_log_group.data_compactor[*].arn)}:*"]
  }

  statement {
    sid       = "List"
    actions   = ["s3:ListBucket"]
    resources = [one(awscc_s3_bucket.data[*].arn)]
  }

  statement {
    sid       = "ReadRaw"
    actions   = ["s3:GetObject"]
    resources = [for location in values(local.data_locations) : "${one(awscc_s3_bucket.data[*].arn)}/${location.prefix}*"]
  }

  statement {
    sid       = "WriteParquet"
    actions   = ["s3:PutObject"]
    resources = [for location in values(local.data_parquet) : "${one(awscc_s3_bucket.data[*].arn)}/${location.prefix}*"]
  }

  statement {
    sid       = "Start"
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:${data.aws_partition.current.partition}:lambda:${var.region}:${data.aws_caller_identity.data.account_id}:function:${local.data_compactor}"]
  }
}

resource "aws_iam_role" "data_compactor" {
  count = local.data_count

  name                 = local.data_compactor
  assume_role_policy   = data.aws_iam_policy_document.data_compactor_assume.json
  permissions_boundary = local.permissions_boundary
}

resource "aws_iam_role_policy" "data_compactor" {
  count = local.data_count

  name   = "runtime"
  role   = one(aws_iam_role.data_compactor[*].id)
  policy = one(data.aws_iam_policy_document.data_compactor[*].json)
}

resource "aws_cloudwatch_log_group" "data_compactor" {
  count = local.data_count

  name              = "/aws/lambda/${local.data_compactor}"
  retention_in_days = 14
}

resource "aws_lambda_function" "data_compactor" {
  count = local.data_count

  function_name    = local.data_compactor
  role             = one(aws_iam_role.data_compactor[*].arn)
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "compactor.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 1024
  timeout          = 300

  environment {
    variables = {
      # Names the service on every log line (src/lib/log.ts), in OpenTelemetry's terms.
      OTEL_SERVICE_NAME = var.name
      DATA_BUCKET       = local.data_bucket
      DATA_LOCATIONS    = jsonencode({ for major, location in local.data_locations : major => { raw = location.prefix, parquet = local.data_parquet[major].prefix } })
      LOOKBACK_DAYS     = "3"
    }
  }

  depends_on = [aws_cloudwatch_log_group.data_compactor, aws_iam_role_policy.data_compactor]
}

resource "aws_scheduler_schedule" "data_compaction" {
  count = local.data_count

  name                = "${var.name}-data-compaction"
  description         = "Compacts the events ${var.name} kept as data into Parquet, the last three days, every day."
  schedule_expression = "cron(17 0 * * ? *)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = one(aws_lambda_function.data_compactor[*].arn)
    role_arn = one(aws_iam_role.data_compactor[*].arn)
    input    = jsonencode({})

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# --- Alarms -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "data_delivery" {
  for_each = local.data_majors

  alarm_name          = "${var.name}-data-${each.key}-delivery"
  alarm_description   = "Firehose is failing to write events to S3: they are held for a day and then lost as data. Runbook: docs/data.md#data-delivery"
  namespace           = "AWS/Firehose"
  metric_name         = "DeliveryToS3.Success"
  dimensions          = { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.data[each.key].name }
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
  for_each = local.data_majors

  alarm_name          = "${var.name}-data-${each.key}-freshness"
  alarm_description   = "The oldest event not yet in S3 is older than the data contract promises. Runbook: docs/data.md#data-freshness"
  namespace           = "AWS/Firehose"
  metric_name         = "DeliveryToS3.DataFreshness"
  dimensions          = { DeliveryStreamName = aws_kinesis_firehose_delivery_stream.data[each.key].name }
  statistic           = "Maximum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = local.data_latency[each.key] # seconds, from the contract's latency
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "data_rule" {
  for_each = local.data_majors

  alarm_name          = "${var.name}-data-${each.key}-rule"
  alarm_description   = "The bus could not hand events to Firehose: they were published but are not being kept. Runbook: docs/data.md#data-rule"
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { EventBusName = local.bus_name, RuleName = aws_cloudwatch_event_rule.data[each.key].name }
  statistic           = "Sum"
  period              = local.alarm_period
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_action
  ok_actions          = local.alarm_action
}

resource "aws_cloudwatch_metric_alarm" "data_compaction" {
  count = local.data_count

  alarm_name          = "${var.name}-data-compaction"
  alarm_description   = "The daily compaction to Parquet failed: the Parquet is behind the raw JSON until it succeeds. Runbook: docs/data.md#data-compaction"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = one(aws_lambda_function.data_compactor[*].function_name) }
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
  value       = local.data_bucket
}

output "data_prefixes" {
  description = "Where each major of the data contract keeps them, as JSON: {\"v1\": \"<prefix ending /v1/>\"}, each holding type=<event type>/dt=<date>/."
  value       = jsonencode({ for major, location in local.data_locations : major => location.prefix })
}

output "data_parquet_prefixes" {
  description = "Where each major's Parquet is, as JSON: {\"v1\": \"<prefix ending /v1/>\"}, each holding type=<event type>/dt=<day>/events.parquet."
  value       = jsonencode({ for major, location in local.data_parquet : major => location.prefix })
}

output "data_compactor" {
  description = "The function that compacts the raw JSON into Parquet; empty when the API has no data contract."
  value       = local.data_enabled ? local.data_compactor : ""
}

output "data_compression" {
  description = "How the files are written: UNCOMPRESSED or GZIP."
  value       = local.data_enabled ? var.data_compression : ""
}

output "data_streams" {
  description = "The Firehose stream that writes each major's data, as JSON."
  value       = jsonencode({ for major, stream in aws_kinesis_firehose_delivery_stream.data : major => stream.name })
}
