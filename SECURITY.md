# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
**Security → Report a vulnerability** on this repository (GitHub's private
vulnerability reporting). Say what you found, how to reproduce it, and what
an attacker could do with it.

You will get a reply once it has been read, and you are credited for the fix
unless you ask not to be.

<!-- template-only:start - removed by `task adopt` when a repository becomes an API -->
## What is covered

The template's skeleton on `main`: the router and contract validation, the
local stack, the gates and generators, the CI workflows and the Terraform.
Only the latest `main` is supported; there are no maintained older versions.
An API built from the template is its owner's responsibility.
<!-- template-only:end -->

## What the skeleton does about security

So you know what to rely on, and what to check when reporting:

- **Authentication** is declared in the contract and enforced by an API
  Gateway JWT authorizer; Terraform refuses to deploy a secured operation
  without a token issuer. See [Authentication](docs/deploying.md#authentication).
- **Every request is validated** against the contract before any operation
  runs: its path, query and body. A house rule makes every request body
  refuse unknown fields at its top level; nested objects and query
  parameters are as open as the contract leaves them.
- **Deployment from CI uses no stored keys**: GitHub assumes a role through
  OIDC that is limited to one repository's `main` branch and one stack's
  resources. The roles it makes carry a permissions boundary it cannot
  change, and the job builds nothing: it deploys the bundle the gates
  passed. See [Deploy](docs/deploying.md#deploy).
- **Vulnerable dependencies** get a pull request from Dependabot
  (`.github/dependabot.yml`): the npm packages and GitHub Actions, one per
  ecosystem, held to every gate. Turn on Dependabot alerts and security
  updates under Settings → Code security; version updates stay Renovate's.
- **AWS Emulator is verified** against AWS's signing key before it is used,
  and is never installed system-wide. The Docker image
  (`task emulator:docker`) installs the package without that check.
- **Local callers are not a security test.** On the local stack, AWS
  Emulator's authorizer checks a token's shape, issuer and audience but not
  its signature, so `local/token.ts` can mint callers for tests. On AWS the
  same authorizer verifies every token against your identity provider.

The API is deployed without authentication unless the contract asks for it.
