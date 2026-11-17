terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    # component:data:start
    awscc = {
      source  = "hashicorp/awscc"
      version = "~> 1.0"
    }
    # component:data:end
  }

  # Local state by default. Configure a remote backend before sharing a stack:
  # backend "s3" { ... }
}

provider "aws" {
  region = var.region

  # Whose every resource is (tags.tf).
  default_tags {
    tags = local.tags
  }
}

locals {
  # The contract is the single source of the API's routes: API Gateway gets
  # exactly the operations specs/openapi.yaml declares, nothing more.
  contract         = yamldecode(file("${path.module}/../specs/openapi.yaml"))
  methods          = ["get", "put", "post", "delete", "patch", "head", "options"]
  indexes          = ["gsi1", "gsi2"]
  index_attributes = flatten([for index in local.indexes : ["${index}pk", "${index}sk"]])

  # Operations the contract secures get the JWT authorizer; the rest stay open.
  # OpenAPI: an operation's own `security` replaces the document's, and an
  # empty requirement ({}) allows anonymous calls.
  secured_routes = toset(flatten([
    for path, item in try(local.contract.paths, {}) : [
      for method, operation in item : "${upper(method)} ${path}"
      if contains(local.methods, method) && length(try(operation.security, try(local.contract.security, []))) > 0 && alltrue([
        for requirement in try(operation.security, try(local.contract.security, [])) : length(requirement) > 0
      ])
    ]
  ]))
  jwt_issuer = try(coalesce(var.jwt_issuer), null)
  # CI passes an unset repository variable as "".
  permissions_boundary = try(coalesce(var.permissions_boundary), null)
  jwt_audience         = compact(split(",", var.jwt_audience))

  routes = toset(flatten([
    for path, item in try(local.contract.paths, {}) : [
      for method, operation in item : "${upper(method)} ${path}" if contains(local.methods, method)
    ]
  ]))
}

# --- Data -------------------------------------------------------------------
# Single table with generic string keys, and two generic indexes (gsi1, gsi2)
# for the access patterns the keys cannot serve. An index costs nothing until
# an item carries its attributes. The local stack applies this same file to
# AWS Emulator, so there is no second definition to keep in step.

resource "aws_dynamodb_table" "this" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  dynamic "attribute" {
    for_each = local.index_attributes
    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "global_secondary_index" {
    for_each = local.indexes
    content {
      name            = global_secondary_index.value
      projection_type = "ALL"

      key_schema {
        attribute_name = "${global_secondary_index.value}pk"
        key_type       = "HASH"
      }

      key_schema {
        attribute_name = "${global_secondary_index.value}sk"
        key_type       = "RANGE"
      }
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  # component:publish:start
  # Every new outbox item reaches the forwarder through the table's stream (infra/publish.tf).
  stream_enabled   = true
  stream_view_type = "NEW_IMAGE"
  # component:publish:end

  # component:consume:start
  # The record of each message handled removes itself (src/lib/consumer.ts).
  # The attribute is the consumer's own, so no item of the API's can be caught by it.
  ttl {
    attribute_name = "message_claim_expires_at"
    enabled        = true
  }
  # component:consume:end
}

# --- Lambda -----------------------------------------------------------------

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/.terraform/lambda.zip"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda.arn}:*"]
  }

  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  }
}

resource "aws_iam_role" "lambda" {
  name                 = "${var.name}-lambda"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = local.permissions_boundary
}

resource "aws_iam_role_policy" "lambda" {
  name   = "runtime"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = var.name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.this.name
      # component:asyncapi:start
      # The `source` of every CloudEvent this API publishes.
      EVENT_SOURCE = "/${var.name}"
      # component:asyncapi:end
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

# --- API Gateway HTTP API ---------------------------------------------------

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"

  # Browsers on other origins may call the API only when you name them.
  dynamic "cors_configuration" {
    for_each = length(var.cors_allowed_origins) > 0 ? [1] : []
    content {
      allow_origins = var.cors_allowed_origins
      allow_methods = ["*"]
      allow_headers = ["authorization", "content-type"]
      max_age       = 300
    }
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

# Verifies the bearer token on every secured route before the Lambda runs,
# and answers 401 itself when it is missing or invalid.
resource "aws_apigatewayv2_authorizer" "jwt" {
  count = local.jwt_issuer == null ? 0 : 1

  api_id           = aws_apigatewayv2_api.this.id
  name             = "jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = local.jwt_issuer
    audience = local.jwt_audience
  }
}

resource "aws_apigatewayv2_route" "operation" {
  for_each = local.routes

  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.value
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = contains(local.secured_routes, each.value) ? "JWT" : "NONE"
  authorizer_id      = contains(local.secured_routes, each.value) ? one(aws_apigatewayv2_authorizer.jwt[*].id) : null

  lifecycle {
    # Never deploy a route the contract secures without something to secure it.
    precondition {
      condition     = !contains(local.secured_routes, each.value) || local.jwt_issuer != null
      error_message = "The contract secures ${each.value}, but no token issuer is configured. Set jwt_issuer (and jwt_audience)."
    }
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  # A limit on what callers can make the API do, and cost, when you set one.
  dynamic "default_route_settings" {
    for_each = var.throttle_rate_limit != null || var.throttle_burst_limit != null ? [1] : []
    content {
      throttling_rate_limit  = var.throttle_rate_limit
      throttling_burst_limit = var.throttle_burst_limit
    }
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowHttpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
