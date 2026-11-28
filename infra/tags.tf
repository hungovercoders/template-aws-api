# Whose this is. Every resource the stack creates says which domain and team
# own it, which service it belongs to and where its code lives, so that in an
# account shared by many APIs a cost can be attributed, an alarm routed, and
# a queue or a table traced back to the repository that defines it.
#
# `domain` and `team` are the owner's to say, once, in
# infra/tags.auto.tfvars.json - committed, so they are reviewed like any
# other change, and read by every apply: the local stack, `task deploy` and
# CI alike. `service` is the stack's name and `repo` is read from the
# repository's git remote (scripts/tags.ts); neither is typed.

variable "domain" {
  description = "The business domain that owns this API. Set in infra/tags.auto.tfvars.json."
  type        = string

  validation {
    condition     = trimspace(var.domain) != ""
    error_message = "The `domain` tag has no value. Say which business domain owns this API in infra/tags.auto.tfvars.json, and commit it."
  }
}

variable "team" {
  description = "The team that owns this API. Set in infra/tags.auto.tfvars.json."
  type        = string

  validation {
    condition     = trimspace(var.team) != ""
    error_message = "The `team` tag has no value. Say which team owns this API in infra/tags.auto.tfvars.json, and commit it."
  }
}

variable "repo" {
  description = "The URL of the repository that defines the stack. The tasks read it from the git remote; set it by hand only when applying without them."
  type        = string

  validation {
    condition     = can(regex("^https?://", var.repo))
    error_message = "The `repo` tag has no value. Apply through `task deploy` or the local stack, which read it from the git remote, or pass -var repo=<the repository's URL>."
  }
}

locals {
  # A stack named for a stage of its life says so: my-api-test is the test environment of my-api.
  environment = try(regex("-(dev|test|staging|prod)$", var.name)[0], null)

  # On every resource. The AWS provider adds them itself (default_tags, in
  # main.tf); a resource of any other provider is given them by name, and
  # `task tags:check` fails for one that is not.
  tags = merge(
    { domain = var.domain, team = var.team, service = var.name, repo = var.repo },
    local.environment == null ? {} : { environment = local.environment },
  )

  # Where the docs are, as a link: every alarm ends on the section of the
  # runbook that says what to do about it, and whoever is paged opens it from
  # the alarm itself. HEAD is the default branch, whatever it is called.
  docs = "${var.repo}/blob/HEAD/docs"
}

# Everything tagged with this service, in one place: the console's Resource
# Groups, and `aws resource-groups list-group-resources --group-name <name>`.
resource "aws_resourcegroups_group" "service" {
  name = var.name
  # Letters, digits, spaces, dots, hyphens and underscores are all a description may hold.
  description = "Every resource tagged with the service ${var.name}"

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters          = [{ Key = "service", Values = [var.name] }]
    })
  }
}
