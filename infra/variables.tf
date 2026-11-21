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

variable "jwt_issuer" {
  description = "Issuer URL of the tokens callers present, e.g. https://cognito-idp.eu-west-2.amazonaws.com/<pool-id>. Required when the contract secures any operation."
  type        = string
  default     = null
}

variable "jwt_audience" {
  description = "Audiences (client ids) a token must be issued for; comma-separated."
  type        = string
  default     = ""
}

variable "alarm_email" {
  description = "Address to email when an alarm fires or recovers. It must confirm the subscription AWS sends it."
  type        = string
  default     = ""
}

variable "alarm_topic_arn" {
  description = "An existing SNS topic to notify instead of creating one - for example one wired to your on-call tool."
  type        = string
  default     = ""
}

variable "permissions_boundary" {
  description = "ARN of the permissions boundary every role of the stack carries: the most any of them can ever be allowed, whatever its policy says. `task aws:bootstrap` makes one and limits the deploy role to roles that carry it. Empty: no boundary."
  type        = string
  default     = null
}

# Both or neither: API Gateway reads a limit left out as 0, which refuses every request.
variable "throttle_rate_limit" {
  description = "Requests a second the API accepts, across all routes, before it answers 429. Set it with throttle_burst_limit. Empty: the account's own limits."
  type        = string
  default     = null

  validation {
    condition     = try(coalesce(var.throttle_rate_limit), null) == null || can(tonumber(var.throttle_rate_limit))
    error_message = "throttle_rate_limit is a number of requests a second."
  }
}

variable "throttle_burst_limit" {
  description = "How many requests the API accepts at once. Set it with throttle_rate_limit. Empty: the account's own limits."
  type        = string
  default     = null

  validation {
    condition     = try(coalesce(var.throttle_burst_limit), null) == null || can(tonumber(var.throttle_burst_limit))
    error_message = "throttle_burst_limit is a whole number of requests."
  }
}

variable "specs" {
  description = "Where the contracts are read from, relative to infra/. Only the plan tests in infra/tests/ change it, to read fixtures of their own."
  type        = string
  default     = "../specs"
}
