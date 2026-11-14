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
