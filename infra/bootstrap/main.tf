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

  # The same tags as the stack this account setup is for (infra/tags.tf).
  default_tags {
    tags = local.tags
  }
}

# Kept the same as infra/tags.tf, so a service is one thing to whoever filters by a tag.
locals {
  environment = try(regex("-(dev|test|staging|prod)$", var.name)[0], null)
  tags = merge(
    { domain = var.domain, team = var.team, service = var.name, repo = var.repo },
    local.environment == null ? {} : { environment = local.environment },
  )
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account   = data.aws_caller_identity.current.account_id
  partition = data.aws_partition.current.partition
  bucket    = "${var.name}-tfstate-${local.account}"
  oidc_arn  = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : "arn:${local.partition}:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com"
}

# component:data:start
# The buckets the data contract names, one for each of its S3 servers: the
# only buckets, besides the state's, the deploy role may manage. Apply the
# bootstrap again when the contract gains a server.
locals {
  data_contract_file = "${path.module}/../../specs/datacontract.yaml"
  data_buckets = fileexists(local.data_contract_file) ? [
    for server in try(yamldecode(file(local.data_contract_file)).servers, []) : regex("^s3://([^/]+)/", server.location)[0] if try(server.type, "") == "s3"
  ] : []
}
# component:data:end

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

# --- The most a role of the stack may ever do ---------------------------------------
# The deploy role makes the stack's roles and writes their policies, so on its
# own it could give one of them anything. This is the limit: a permissions
# boundary every role of the stack must carry (infra/'s permissions_boundary),
# and the deploy role may only make, or write a policy for, a role that does.
# Whatever a role's policy says, it can do no more than this - the stack's own
# resources, and nothing of IAM. The deploy role cannot change the boundary.
#
# An API whose function comes to need another AWS service adds it here, and
# the bootstrap is applied again by a person: that is the review.

data "aws_iam_policy_document" "boundary" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${var.region}:${local.account}:log-group:/aws/lambda/${var.name}*"]
  }

  # The table, its indexes and its stream.
  statement {
    sid     = "Table"
    actions = ["dynamodb:*"]
    resources = [
      "arn:${local.partition}:dynamodb:${var.region}:${local.account}:table/${var.name}",
      "arn:${local.partition}:dynamodb:${var.region}:${local.account}:table/${var.name}/*",
    ]
  }

  # component:consume:start
  statement {
    sid       = "Queues"
    actions   = ["sqs:*"]
    resources = ["arn:${local.partition}:sqs:${var.region}:${local.account}:${var.name}-messages*"]
  }
  # component:consume:end

  # component:publish:start
  # The stack's own bus, or an existing one it was told to publish to.
  statement {
    sid       = "Publish"
    actions   = ["events:PutEvents"]
    resources = ["arn:${local.partition}:events:${var.region}:${local.account}:event-bus/*"]
  }

  statement {
    sid       = "Unpublished"
    actions   = ["sqs:*"]
    resources = ["arn:${local.partition}:sqs:${var.region}:${local.account}:${var.name}-unpublished"]
  }
  # component:publish:end

  # component:data:start
  statement {
    sid       = "DataStream"
    actions   = ["firehose:PutRecord", "firehose:PutRecordBatch"]
    resources = ["arn:${local.partition}:firehose:${var.region}:${local.account}:deliverystream/${var.name}-data"]
  }

  dynamic "statement" {
    for_each = length(local.data_buckets) > 0 ? [1] : []

    content {
      sid       = "DataBucket"
      actions   = ["s3:*"]
      resources = flatten([for bucket in local.data_buckets : ["arn:${local.partition}:s3:::${bucket}", "arn:${local.partition}:s3:::${bucket}/*"]])
    }
  }
  # component:data:end
}

resource "aws_iam_policy" "boundary" {
  name        = "${var.name}-boundary"
  description = "The most any role of the ${var.name} stack may do"
  policy      = data.aws_iam_policy_document.boundary.json
}

locals {
  # Allowed only on a role that carries the boundary: making it, writing its
  # policy, and putting the boundary on a role made before there was one.
  bounded_role_actions = ["iam:CreateRole", "iam:PutRolePolicy", "iam:PutRolePermissionsBoundary"]
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

  # A mapping has no name before it exists, so making, changing and removing
  # one is limited to this stack's function instead.
  statement {
    sid       = "ConsumerMapping"
    actions   = ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "lambda:FunctionArn"
      values   = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}-consumer"]
    }
  }

  # Reading mappings cannot be limited to one function.
  statement {
    sid       = "ConsumerMappingRead"
    actions   = ["lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings"]
    resources = ["*"]
  }

  # Tags on mappings only - not on any function in the account.
  statement {
    sid       = "ConsumerMappingTags"
    actions   = ["lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"]
    resources = ["arn:${local.partition}:lambda:${var.region}:${local.account}:event-source-mapping:*"]
  }

  statement {
    sid = "ConsumerRole"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-consumer"]
  }

  statement {
    sid       = "ConsumerRoleBounded"
    actions   = local.bounded_role_actions
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-consumer"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }
  # component:consume:end

  # The resource group that gathers the service (infra/tags.tf), and no other.
  statement {
    sid       = "ResourceGroup"
    actions   = ["resource-groups:*"]
    resources = ["arn:${local.partition}:resource-groups:${var.region}:${local.account}:group/${var.name}"]
  }

  # Making a group checks its query, which reads tags; nothing is changed by it.
  statement {
    sid       = "ResourceGroupQuery"
    actions   = ["tag:GetResources", "cloudformation:DescribeStacks", "cloudformation:ListStackResources"]
    resources = ["*"]
  }

  # component:publish:start
  # Published events: the bus, its archive, rule and log, the forwarder
  # function, its role and its mapping to the table's stream, and the queue
  # of events that could not be published (infra/publish.tf).
  statement {
    sid     = "Events"
    actions = ["events:*"]
    resources = [
      "arn:${local.partition}:events:${var.region}:${local.account}:event-bus/${var.name}",
      # On the stack's own bus, or on an existing one it was told to use.
      "arn:${local.partition}:events:${var.region}:${local.account}:rule/*/${var.name}-*",
      "arn:${local.partition}:events:${var.region}:${local.account}:archive/${var.name}",
    ]
  }

  # An existing bus is only read.
  statement {
    sid       = "EventBusRead"
    actions   = ["events:DescribeEventBus", "events:ListTagsForResource"]
    resources = ["arn:${local.partition}:events:${var.region}:${local.account}:event-bus/*"]
  }

  # A log group's resource policy has no ARN to name.
  statement {
    sid       = "EventLogPolicy"
    actions   = ["logs:PutResourcePolicy", "logs:DeleteResourcePolicy", "logs:DescribeResourcePolicies"]
    resources = ["*"]
  }

  statement {
    sid       = "EventLog"
    actions   = ["logs:*"]
    resources = ["arn:${local.partition}:logs:${var.region}:${local.account}:log-group:/aws/events/${var.name}*"]
  }

  statement {
    sid       = "Unpublished"
    actions   = ["sqs:*"]
    resources = ["arn:${local.partition}:sqs:${var.region}:${local.account}:${var.name}-unpublished"]
  }

  statement {
    sid       = "Forwarder"
    actions   = ["lambda:*"]
    resources = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}-forwarder"]
  }

  statement {
    sid       = "ForwarderMapping"
    actions   = ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping"]
    resources = ["*"]

    condition {
      test     = "StringLike"
      variable = "lambda:FunctionArn"
      values   = ["arn:${local.partition}:lambda:${var.region}:${local.account}:function:${var.name}-forwarder"]
    }
  }

  statement {
    sid       = "ForwarderMappingRead"
    actions   = ["lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings"]
    resources = ["*"]
  }

  statement {
    sid       = "ForwarderMappingTags"
    actions   = ["lambda:TagResource", "lambda:UntagResource", "lambda:ListTags"]
    resources = ["arn:${local.partition}:lambda:${var.region}:${local.account}:event-source-mapping:*"]
  }

  statement {
    sid = "ForwarderRole"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-forwarder"]
  }

  statement {
    sid       = "ForwarderRoleBounded"
    actions   = local.bounded_role_actions
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-forwarder"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }
  # component:publish:end

  # component:data:start
  # The events as data: the bucket, the Firehose stream that writes to it and
  # the role the rule and the stream use (infra/data.tf). The rule itself is
  # covered by the published events' statement above.
  #
  # The bucket is made through Cloud Control, which has no resource of its
  # own to name; what it may touch is held by the S3 statement after it.
  statement {
    sid       = "CloudControl"
    actions   = ["cloudformation:CreateResource", "cloudformation:GetResource", "cloudformation:UpdateResource", "cloudformation:DeleteResource", "cloudformation:GetResourceRequestStatus"]
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = length(local.data_buckets) > 0 ? [1] : []

    content {
      sid       = "DataBucket"
      actions   = ["s3:*"]
      resources = flatten([for bucket in local.data_buckets : ["arn:${local.partition}:s3:::${bucket}", "arn:${local.partition}:s3:::${bucket}/*"]])
    }
  }

  statement {
    sid       = "DataStream"
    actions   = ["firehose:*"]
    resources = ["arn:${local.partition}:firehose:${var.region}:${local.account}:deliverystream/${var.name}-data"]
  }

  statement {
    sid = "DataRole"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-data"]
  }

  statement {
    sid       = "DataRoleBounded"
    actions   = local.bounded_role_actions
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-data"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
  }
  # component:data:end

  # The Lambda's execution role. Managing a role means this role can decide
  # what the Lambda is allowed to do - within the boundary above, which it
  # cannot change or take off. Review changes to infra/ accordingly.
  statement {
    sid = "ExecutionRole"
    actions = [
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:PassRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-lambda"]
  }

  statement {
    sid       = "ExecutionRoleBounded"
    actions   = local.bounded_role_actions
    resources = ["arn:${local.partition}:iam::${local.account}:role/${var.name}-lambda"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.boundary.arn]
    }
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
