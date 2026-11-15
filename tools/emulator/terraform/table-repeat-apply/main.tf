# An on-demand table, applied twice: the second apply changes one tag.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "revision" {
  type    = string
  default = "1"
}

resource "aws_dynamodb_table" "probe" {
  name         = "gap-table-repeat-apply"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  tags = { revision = var.revision }
}
