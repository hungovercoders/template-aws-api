# The values to store as GitHub Actions repository variables (not secrets).
output "github_variables" {
  description = "Set each of these under Settings > Secrets and variables > Actions > Variables."
  value = {
    AWS_DEPLOY_ROLE_ARN      = aws_iam_role.deploy.arn
    AWS_REGION               = var.region
    TF_STATE_BUCKET          = aws_s3_bucket.state.bucket
    STACK_NAME               = var.name
    PERMISSIONS_BOUNDARY_ARN = aws_iam_policy.boundary.arn
  }
}
