# Maintaining the template

> **For** whoever looks after the template or an API built from it. **When** changing the skeleton, updating dependencies, or creating a repository from the template.

## Using this repository as a template

Create your repository with **Use this template** on GitHub. You only need
`main`: leave "Include all branches" unticked. The example branches are for
reading, not for building on.

Then, in your new repository:

- Delete `.github/rulesets/`, `.github/workflows/template.yml` and the
  "Branches" section of `CLAUDE.md`. They describe how *this* repository
  keeps and tests its example branches, not your API.
- Replace this README's top section with a description of your API. The rest
  is a working manual for the tooling and can stay.
- Change the copyright line in `LICENSE` if the code is not MIT or not yours
  to license that way.
- Add your spec and carry on from [Use it](../README.md#use-it). CI is red until the spec
  is implemented, and green from then on.

## What gets documented

Context is hard to manage, so a document exists only where it is necessary:

1. **Prefer something executable.** A gate, a generator, a task's
   description or an alarm's description says it once and cannot go stale.
   Write prose only for what none of those can carry.
2. **Every document names its reader and their moment.** Each guide opens
   with who it is for and when. If you cannot fill that in, do not write it.
3. **One home per fact.** State it once and link to it.

`task docs:check`, a gate in `task ci`, holds this in place: it fails when
`CLAUDE.md`, a skill, the README or a guide outgrows its line budget, when a
guide does not say who it is for and when, and when a link between documents
does not resolve. The budgets are at the top of `scripts/docs-check.ts`.
Raising one is allowed, and is a decision: first ask what could be cut, or
turned into a gate.

Deliberately absent: architecture documents (the contract, the features and
the Terraform are the description), decision records (a skeleton change is
recorded by its `task skeleton:lock` commit) and a changelog (`task
spec:compat` prints one).

## Changing the skeleton

`skeleton.lock` records every skeleton file - the router and contract
library, the local stack, the gates, CI, the Terraform, the skills.
`task skeleton:check`, the first gate in `task ci`, fails if any of them
differs. That makes "do not rebuild the skeleton" a check rather than a
request: an agent cannot quietly weaken a gate or rewrite the router to get
green.

Changing the skeleton is still possible - an index, a new alarm, an upgrade -
but it is a deliberate step by a person:

```sh
task skeleton:lock      # accept the skeleton as it is now, then commit skeleton.lock
```

The changed lock shows in the diff, so a reviewer sees that the skeleton
moved and asks why. Version pins (`*_VERSION` in `Taskfile.yml`, action
versions in the workflow) are ignored, so Renovate's updates do not trip it.
If a change would help every API, make it in the template instead.

## Keeping dependencies current

`renovate.json` covers npm, GitHub Actions, Terraform providers and mise
tools, and raises the AWS Emulator and Prism versions pinned in
`Taskfile.yml`. Install the [Renovate app](https://github.com/apps/renovate)
on your repository to switch it on.

## Conventions the template assumes

- Request and response bodies are JSON.
- Errors are RFC 9457 `application/problem+json` (`Problem` in the contract).
- One DynamoDB table with string keys `pk` and `sk`, and two generic indexes
  (`gsi1`, `gsi2`, keyed on `gsi1pk`/`gsi1sk` and `gsi2pk`/`gsi2sk`) for
  listings and lookups the keys cannot serve. Defined once in `infra/main.tf`
  and created from it for local runs too.
