output "base_url" {
  description = "Base URL of the deployed API."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "table_name" {
  value = aws_dynamodb_table.this.name
}

output "alarm_topic_arn" {
  description = "The SNS topic the stack's alarms notify. Subscribe your on-call tool to it."
  value       = local.alarm_topic
}
