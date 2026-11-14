variable "name" {
  description = "Name of the stack; used for the Lambda, the API and the table."
  type        = string
}

variable "region" {
  description = "AWS region to deploy to."
  type        = string
  default     = "eu-west-2"
}
