output "base_url" {
  description = "Base URL of the deployed API."
  # The API's own endpoint, not the stage's invoke_url: the two are the same on
  # AWS for the $default stage, and on AWS Emulator this one is the local URL.
  value      = "${aws_apigatewayv2_api.this.api_endpoint}/"
  depends_on = [aws_apigatewayv2_stage.default]
}

output "table_name" {
  value = aws_dynamodb_table.this.name
}

output "alarm_topic_arn" {
  description = "The SNS topic the stack's alarms notify. Subscribe your on-call tool to it."
  value       = local.alarm_topic
}

output "permissions_boundary" {
  description = "The permissions boundary the stack's roles carry, if any. An apply through the tasks that names none keeps this one."
  value       = local.permissions_boundary
}
