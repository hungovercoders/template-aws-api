variable "name" {
  description = "The stack name CI will deploy (the NAME you pass to task deploy). The deploy role is limited to it."
  type        = string
}

variable "github_repository" {
  description = "The repository allowed to deploy, as owner/repo."
  type        = string
}

variable "region" {
  description = "AWS region the stack and its state bucket live in."
  type        = string
  default     = "eu-west-2"
}

variable "create_oidc_provider" {
  description = "Create the account's GitHub OIDC provider. Set false if the account already has one."
  type        = bool
  default     = true
}
