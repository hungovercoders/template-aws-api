# Deploying

> **For** whoever puts an API on AWS. **When** the first deploy, and when wiring up sign-in, CORS or CI deployment.

## Deploy

Terraform in `infra/` creates the Lambda (Node 22, arm64), an API Gateway HTTP
API with one route per contract operation, and a DynamoDB table. Operations
the contract secures get a JWT authorizer ([Authentication](#authentication));
the rest are open. An optional component adds its own part, described with it.

Deploying is **opt-in**. Nothing in `task ci` touches AWS, and the template
works end to end without an AWS account.

### Tags

Every resource carries four tags, so that in a shared account it says whose
it is: `domain` and `team` (who owns it), `service` (the stack's name) and
`repo` (this repository's URL, read from the git remote). A stack whose name
ends `-dev`, `-test`, `-staging` or `-prod` also carries `environment`.

`domain` and `team` are yours to say, once, in `infra/tags.auto.tfvars.json`,
and what the stack may cost a month in `infra/budget.auto.tfvars.json`
([cost](#cost)); commit them. Nothing is applied - locally or to AWS - while one is empty,
and `task tags` shows what a stack would carry. A resource group named after
the stack gathers everything tagged with its `service`; `ENV=aws task resources`
lists what the stack created, by service, with a link to that group in the console.

`task tags:check` fails for a resource that could carry the tags and would
not: the AWS provider adds them to everything, and a resource of any other
provider must be given `local.tags` by name.

### From your machine

With AWS credentials in your shell:

```sh
task deploy NAME=my-api                       # region: AWS_REGION, else eu-west-2
AWS_REGION=eu-west-1 task deploy NAME=my-api
task destroy NAME=my-api
```

State is a local file (`infra/terraform.tfstate`) unless `TF_STATE_BUCKET` is
set, in which case it is kept in that S3 bucket under `<NAME>/`. `task deploy`
refuses to run while `AWS_ENDPOINT_URL` points at an emulator.

### Bring your AWS account: deploy from CI

The `deploy` job in `.github/workflows/ci.yml` deploys `main` after `task ci`
passes. It is skipped until you set it up, which takes three steps:

1. **Bootstrap the account, once.** With administrator credentials in your
   shell:

   ```sh
   task aws:bootstrap NAME=my-api REPO=my-org/my-api
   ```

   This applies `infra/bootstrap/`, which creates an S3 bucket for Terraform
   state and an IAM role that GitHub Actions assumes through OIDC - no access
   keys are created or stored. The role can be assumed only by this
   repository's `main` branch and can manage only the resources `infra/`
   creates for the stack called `NAME`. It also creates a permissions
   boundary: the most any role of the stack can be allowed - its own table,
   queues, bus and logs. The deploy role can only make roles that carry it,
   so a change to `infra/` cannot grant more. A function that comes to need
   another AWS service has it added to the boundary in `infra/bootstrap/`,
   and the bootstrap applied again. If the account already has GitHub's
   OIDC provider, add `-- -var create_oidc_provider=false`. For a region other
   than eu-west-2, add `-- -var region=<region>`. Say the [tags](#tags) first:
   the role and the bucket carry them, and nothing is applied without them.

2. **Give GitHub the outputs.** The command prints five values. Add each as a
   repository **variable** (Settings → Secrets and variables → Actions →
   Variables). None of them is a secret.

   | Variable | What it is |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | The role the job assumes. Setting this is what switches the job on. |
   | `AWS_REGION` | Where the stack is deployed |
   | `TF_STATE_BUCKET` | Where Terraform state is kept |
   | `STACK_NAME` | The `NAME` you bootstrapped |
   | `PERMISSIONS_BOUNDARY_ARN` | The boundary the stack's roles carry. A stack bootstrapped before there was one deploys as before until you apply the bootstrap again and set this. Do the two together: a deploy between them is refused. |

3. **Push to `main`.** When `task ci` is green the `deploy` job deploys the
   bundle those gates passed (`task deploy:built`: it builds nothing, so no
   dependency runs with AWS credentials); the API's URL is the `base_url`
   output at the end of its log.

To switch it off again, delete the `AWS_DEPLOY_ROLE_ARN` variable. To remove
everything: `task destroy NAME=my-api`, then
`terraform -chdir=infra/bootstrap destroy` with the same variables.

Keep `infra/bootstrap/terraform.tfstate` somewhere safe - it is how the bucket
and role are changed or removed later, and it is not committed.

The deploy job deploys; it does not yet run the features against the deployed
API. They reset data through the local harness, which a real stack does not
have.

## Authentication

Who may call an operation is part of the contract, and the contract is the
only place you say it:

```yaml
security:                 # for every operation, or per operation
  - bearer_auth: []
components:
  securitySchemes:
    bearer_auth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

From that one declaration:

| Where | What happens |
| --- | --- |
| AWS | Terraform puts an API Gateway JWT authorizer on exactly the secured routes. It verifies the token and answers 401 itself; the Lambda never sees an unauthenticated request. |
| Your code | A secured operation always has `context.caller` (`subject` and the token's `claims`). |
| Local stack and CI | The same authorizer, on AWS Emulator: it checks a token's shape, issuer and audience, not its signature. In step definitions, set `this.caller = "<subject>"`; by hand, `node local/token.ts <subject>` prints a token. |
| `spec:check` | A secured operation must use an HTTP bearer scheme and document 401. |

Deploying a contract with secured operations needs to know who issues the
tokens - any OIDC provider (Cognito, Auth0, Entra ID, Clerk):

```sh
task deploy NAME=my-api -- -var jwt_issuer=https://issuer.example.com/ -var jwt_audience=my-client-id
```

In the CI deploy job these come from the repository variables `JWT_ISSUER`
and `JWT_AUDIENCE`. Terraform refuses to deploy a secured route without an
issuer, so a contract that asks for authentication can never be deployed open.

Document 401 as `application/json` with a `message` - that is the body API
Gateway sends, and the one 4xx the router does not produce. What a caller is
*allowed* to do (roles, ownership) is your business logic: decide it in the
operation from `context.caller` and answer 403 with a problem.

Real tokens are verified only on AWS. The local test caller proves your
routes and rules, not your identity provider's configuration.

<!-- component:consume:start -->
## Messages

The stack makes a standard queue, `<name>-messages`, a dead-letter queue and
the function that consumes them. What a sender needs is the `queue_url` and
`queue_arn` outputs, and permission to send, which is yours to grant.

| Variable | Default | What it is |
| --- | --- | --- |
| `consume_timeout` | 10 | Seconds the consumer may take over one batch |
| `consume_visibility_timeout` | six times the timeout | Seconds before a message that was not finished is offered again |
| `consume_max_receives` | 3 | Times a message is offered before it goes to the dead-letter queue |
| `consume_fifo` | false | A FIFO queue: messages of one group in order, each once. Changing it replaces the queue |
<!-- component:consume:end -->

<!-- component:publish:start -->
## Events

The stack makes its own event bus, named after it, with an archive of 30
days (`-var event_archive_days=N`; 0 for none) and a log of everything
published (`event_log_days`, 1 by default: it is for looking, not keeping).

- **An existing bus.** `-var event_bus_name=<name>` publishes to a bus you
  already run instead. The archive and the log are still made, and hold
  only this API's events. With a permissions boundary, name the bus at the
  bootstrap too (`-- -var 'event_buses=["<name>"]'`): the boundary lets the
  stack publish to its own bus and the ones named there, no other.
- **Subscribers in other accounts.** `-var 'event_subscriber_accounts=["123456789012"]'`
  lets each account put its own rules on the bus. A subscriber in this
  account needs nothing: it adds a rule matching `source` `/<name>` and the
  `detail-type` it wants, which is the event's `type`.
<!-- component:publish:end -->

## Logging and CORS

- **Logging.** Every line is an OpenTelemetry log record (`src/lib/log.ts`):
  `Timestamp`, `SeverityText`, `Body`, `TraceId` and `SpanId` (the caller's trace, when it sent
  a W3C `traceparent` header), the `Resource` that wrote it, and `Attributes`. The router
  writes one per request - `request_id`, `route_key`, `operation_id`, `status`, `duration_ms` -
  and logs any unexpected error with the same `request_id`. Operations get the same logger
  as `context.log`, so their lines can be joined to the request in CloudWatch
  Logs Insights. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`)
  sets what is written; test runs use `warn` to keep their output readable.
- **CORS.** Off by default. To let browsers on other origins call the API,
  deploy with `-- -var 'cors_allowed_origins=["https://app.example.com"]'`.
  API Gateway answers the preflight requests itself; no gate covers CORS on
  the local stack.

## Cost

`monthly_budget_usd` in `infra/budget.auto.tfvars.json` is what the stack may
cost a month. An AWS Budgets budget named after the stack counts what carries
its `service` tag and notifies the alarm topic at 80% of it and at a forecast of
100% (`docs/runbook.md#budget`). AWS counts a tag only once it is activated as a
cost allocation tag: in the Billing console, activate `service` once per account.

## Limiting requests

Without a limit a caller can make the API do, and cost, as much as the
account allows. The limit is the contract's, where callers read it:
`x-rate-limit` in each `specs/openapi.v<N>.yaml` ([rate limits](spec.md#rate-limits-and-service-levels)).
A deploy applies it to that major's routes; over it the API answers 429.
