# One-off account setup for deploying from GitHub Actions. Opt-in: nothing in
# the template needs this until you want CI to deploy to your AWS account.
#
# Run once, by a person with administrator credentials: `task aws:bootstrap`.
# It creates
#   - an S3 bucket for the stack's Terraform state
#   - (optionally) the account's GitHub OIDC identity provider
#   - an IAM role that only this repository's main branch can assume, limited
#     to the resources infra/ creates for one stack name
#
# No long-lived AWS keys are created or stored anywhere.

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  bucket    = "${var.name}-tfstate-${local.account}"
  oidc_arn  = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:${local.partition}:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com"
}

# --- Terraform state ----------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket = local.bucket
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- GitHub OIDC ----------------------------------------------------------------

# An account has at most one provider per issuer. If yours already has GitHub's,
# apply with -var create_oidc_provider=false.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only workflows running on this repository's main branch.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

# --- What the deploy role may do --------------------------------------------------
# Exactly the resources infra/main.tf creates for the stack called var.name.

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "State"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.name}/*"]
  }

  statement {
    sid       = "Table"
    actions   = ["dynamodb:*"]
    resources = ["arn:${local.partition}:dynamodb:${var.region}:${local.account}:table/${var.name}"]
  }

  statement {
    sid       = "Function"
    actions   = ["lambda:*"]
    resources = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}"]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:*"]
    resources = ["arn:${local.partition}:logs:${var.region}:${local.account}:log-group:/aws/lambda/${var.name}*"]
  }

  statement {
    sid       = "LogsList"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # component:consume:start
  # Async input: the queue, its dead-letter queue, the consumer function, its
  # role and its mapping to the queue (infra/consume.tf).
  statement {
    sid       = "Queues"
    actions   = ["sqs:*"]
    resources = ["arn:${local.partition}:sqs:${var.region}:${local.account}:${var.name}-messages*"]
  }

  statement {
    sid       = "Consumer"
    actions   = ["lambda:*"]
    resources = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}-consumer"]
  }

  # A mapping has no name to scope by before it exists; it can only be made for this stack's function.
  statement {
    sid       = "ConsumerMapping"
    actions   = ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings", "lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"]
    resources = ["*"]

    condition {
      test     = "StringLikeIfExists"
      variable = "lambda:FunctionArn"
      values   = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}-consumer"]
    }
  }

  statement {
    sid = "ConsumerRole"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-consumer"]
  }
  # component:consume:end

  # The Lambda's execution role. Managing a role means this role can decide
  # what the Lambda is allowed to do - review changes to infra/ accordingly.
  statement {
    sid = "ExecutionRole"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-lambda"]
  }

  statement {
    sid       = "Alarms"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:ListTagsForResource", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
    resources = ["arn:${local.partition}:cloudwatch:${var.region}:${local.account}:alarm:${var.name}-*"]
  }

  # Describing alarms cannot be limited to named alarms.
  statement {
    sid       = "AlarmsList"
    actions   = ["cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  statement {
    sid       = "AlarmTopic"
    actions   = ["sns:*"]
    resources = ["arn:${local.partition}:sns:${var.region}:${local.account}:${var.name}-alarms"]
  }

  # API Gateway HTTP APIs cannot be scoped by name before they exist.
  statement {
    sid     = "HttpApi"
    actions = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE", "apigateway:TagResource", "apigateway:UntagResource"]
    resources = [
      "arn:${local.partition}:apigateway:${var.region}::/apis",
      "arn:${local.partition}:apigateway:${var.region}::/apis/*",
      "arn:${local.partition}:apigateway:${var.region}::/tags/*",
    ]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
