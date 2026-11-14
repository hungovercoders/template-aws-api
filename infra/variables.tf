variable "name" {
  description = "Name of the stack; used for the Lambda, the API and the table."
  type        = string
}

variable "region" {
  description = "AWS region to deploy to."
  type        = string
  default     = "eu-west-2"
}

variable "cors_allowed_origins" {
  description = "Origins whose browsers may call the API, e.g. [\"https://app.example.com\"]. Empty means no CORS."
  type        = list(string)
  default     = []
}
