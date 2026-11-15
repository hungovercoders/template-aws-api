# The new EventBridge custom event bus as infra/publish.tf would declare it
# (#84): a tagged bus and one subscriber delivering to a queue.
terraform {
  required_providers {
    aws   = { source = "hashicorp/aws", version = "~> 6.0" }
    awscc = { source = "hashicorp/awscc", version = "~> 1.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

provider "awscc" {
  region = "us-east-1"
}

resource "awscc_eventsv2_event_bus" "probe" {
  name                  = "gap-eventsv2-terraform"
  storage_configuration = { retention_period_in_days = 7 }
  tags                  = [{ key = "service", value = "gap-eventsv2-terraform" }]
}

resource "aws_sqs_queue" "target" {
  name = "gap-eventsv2-terraform"
}

resource "aws_iam_role" "deliver" {
  name = "gap-eventsv2-terraform"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "deliver" {
  role = aws_iam_role.deliver.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.target.arn }]
  })
}

resource "awscc_eventsv2_subscriber" "probe" {
  name          = "gap-eventsv2-terraform"
  event_bus_arn = awscc_eventsv2_event_bus.probe.event_bus_arn
  invoke_configuration = {
    target_arn = aws_sqs_queue.target.arn
    role_arn   = aws_iam_role.deliver.arn
  }
}
