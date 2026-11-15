# A bucket as the AWS provider makes one. It asks S3 Control about the
# bucket, which is the call infra/data.tf avoids by going through Cloud Control.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "probe" {
  bucket = "gap-s3-control"
}
