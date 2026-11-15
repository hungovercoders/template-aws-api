# A bucket through Cloud Control that carries its own encryption and
# lifecycle, as it would on AWS. infra/data.tf sets both with separate
# aws_s3_bucket_* resources because the emulator refuses them here.
terraform {
  required_providers {
    awscc = { source = "hashicorp/awscc", version = "~> 1.0" }
  }
}

provider "awscc" {
  region = "us-east-1"
}

resource "awscc_s3_bucket" "encrypted" {
  bucket_name = "gap-cloud-control-encrypted"
  bucket_encryption = {
    server_side_encryption_configuration = [{ server_side_encryption_by_default = { sse_algorithm = "AES256" } }]
  }
}

resource "awscc_s3_bucket" "expiring" {
  bucket_name = "gap-cloud-control-expiring"
  lifecycle_configuration = {
    rules = [{ id = "retention", status = "Enabled", expiration_in_days = 365 }]
  }
}
