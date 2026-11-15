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

variable "domain" {
  description = "The business domain that owns the API; `task aws:bootstrap` reads it from infra/tags.auto.tfvars.json."
  type        = string

  validation {
    condition     = trimspace(var.domain) != ""
    error_message = "The `domain` tag has no value. Say which business domain owns this API in infra/tags.auto.tfvars.json."
  }
}

variable "team" {
  description = "The team that owns the API; `task aws:bootstrap` reads it from infra/tags.auto.tfvars.json."
  type        = string

  validation {
    condition     = trimspace(var.team) != ""
    error_message = "The `team` tag has no value. Say which team owns this API in infra/tags.auto.tfvars.json."
  }
}
