# template-aws-api

**Bring your own business logic.** Everything every Lambda API needs - routing,
request validation, error responses, the DynamoDB client, local emulation, the
test harness, CI, infrastructure, deployment - is solved here once. The only
thing you bring is what makes your API *yours*: BDD feature files that say what
it does and an OpenAPI contract that says what it looks like.

> **CI on this branch is red on purpose.** `main` is the skeleton: no contract,
> no features, no implemented Lambda. `task ci` fails until you add a spec and
> implement it - that is the template working.

## Why a template, not a prompt

The skeleton is the same for every API you will build, so it should be built
once - not regenerated, slightly differently, by AI each time.

- **Known problems are solved up front.** How a Lambda is routed, validated,
  tested, emulated and deployed is not a per-project question. Answering it
  once, in a template, costs nothing to reuse. Asking an agent to answer it
  again costs tokens and review time on every project, and returns a
  different answer each time.
- **AI works only on what is new.** The agent's whole job is the business
  logic: the step definitions and one small function per operation. Less to
  generate is less to pay for, less to review and less to go wrong.
- **The spec is the prompt *and* the test.** The same feature files and
  contract that tell the agent what to build are executed against what it
  built. The agent is not asked whether it is finished - `task ci` tells it,
  with the same answer every time, exactly which scenario or contract rule is
  not yet met.
- **Generate before you write.** Anything a command can derive from the spec
  is produced by that command: types, the route table, a typed stub for every
  operation, a pending step for every sentence, a request for every
  operation. Generated output is identical every time, free, and cannot drift
  from the spec. AI is used only where no deterministic tool exists - the
  behaviour inside each operation and step.
- **Every API looks the same.** Same layout, same tasks, same gates, same
  deployment. Anyone - or any agent - who has seen one has seen them all.

| Solved once, in the template | You bring | AI resolves, checked by the gates |
| --- | --- | --- |
| Lambda entry point and router | `specs/openapi.yaml` - the contract | `steps/*.ts` - glue for your feature sentences |
| Request validation against the contract | `specs/features/*.feature` - the behaviour | `src/operations/*.ts` - one function per operation |
| Authentication, from the contract's `security` | | |
| RFC 9457 error responses | | `src/domain/`, `src/store/` - your rules and data access |
| Types, route table, operation and step outlines generated from the spec | | |
| Local API Gateway stand-in + AWS Emulator | | |
| Contract-checking test harness, fuzzing | | |
| Contract linting to shared standards | | |
| mise, Taskfile, GitHub Actions CI | | |
| Terraform: Lambda, HTTP API, DynamoDB | | |
| Standard alarms and structured logs | | |

If you find yourself asking AI to write a router, a test harness, a pipeline
or Terraform for an API built from this template, stop: it is already here.
If something every API needs is missing, add it to the template once rather
than to one API.

| Branch | What it is | `task ci` |
| --- | --- | --- |
| [`main`](../../tree/main) | The template, ready to use | Red - no spec yet |
| [`example/spec`](../../tree/example/spec) | Template + a complete spec (Beer Catalogue API) | Red - spec not implemented |
| [`example/implementation`](../../tree/example/implementation) | The spec delivered with the `implement-api` skill | Green |

Compare the branches to see each step:
[`main...example/spec`](../../compare/main...example/spec) is what a spec looks
like, and
[`example/spec...example/implementation`](../../compare/example/spec...example/implementation)
is what implementing one adds.

## How it works

```
specs/openapi.yaml ──┬─► request validation inside the Lambda
   (the contract)    ├─► types, the route table and a stub for every operation
                     ├─► API Gateway routes (Terraform reads the contract)
                     ├─► response validation on every call the features make
                     └─► generated fuzz requests (schemathesis)

specs/features/*.feature ──► cucumber, strict, against the built Lambda
   (the behaviour)           on infra/ applied to AWS Emulator
```

The same two files are both the instructions for building the API and the
tests that prove it was built. Nothing is mocked, and what is tested is what
ships: the features call `dist/handler.mjs` - the deployed bundle - over HTTP,
and it talks to a DynamoDB table that the project's own Terraform created on
[AWS Emulator](https://github.com/aws/aws-emulator).

## Use it

Prerequisites: [mise](https://mise.jdx.dev). It installs everything else
(Node, Task, Terraform, uv) from `mise.toml`.

1. **Create your repo** from this template (*Use this template* on GitHub; see
   [Using this repository as a template](#using-this-repository-as-a-template))
   and run `mise install`.
2. **Add your spec.** In Claude Code, `/write-spec` works through it with
   you: it asks for your requirements, drafts the features and contract, and
   checks them against the gates. Or write it by hand:
   - Replace `specs/openapi.yaml` with your contract. Every operation needs an
     `operationId`. Document error responses with the `Problem` schema already
     in the file - it is the error body the router emits.
   - Add feature files to `specs/features/`. Tag each scenario with the
     operations it covers: `@operation:<operationId>`. Every operation needs
     at least one.
   - Add any contract rules of your own to `.spectral.yaml`
     (see [Contract standards](#contract-standards)).
   - `task spec:check` tells you when the spec is complete enough to build
     from, and `task spec:lint` that it meets the standards.
   - `task mock` serves the contract as a mock API, and `ENV=mock task http`
     sends it a request for each operation, so you and your consumers can
     call it and react to its shape before anything is built
     (see [Try the contract before it is built](#try-the-contract-before-it-is-built)).
3. **Implement it.** In [Claude Code](https://claude.com/claude-code), run:

   ```
   /implement-api
   ```

   The skill (`.claude/skills/implement-api`) reads the spec, runs
   `task scaffold` to generate everything that follows from it, fills in the
   steps and operations, and works gate by gate until `task ci` is
   green. It may not edit `specs/`, weaken a gate or rebuild the skeleton. You can follow the same
   steps by hand - they are written out in the skill.
4. **Deploy, when you are ready.** Opt-in: `task deploy NAME=my-api` from your
   machine, or bring your AWS account so CI deploys `main` (see [Deploy](#deploy)).

## Tasks

`task` lists them. The ones you will use:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task scaffold` | Write what follows from the spec: a typed stub per operation, a pending step per sentence |
| `task spec:check` | The contract is valid and every operation has a tagged scenario |
| `task spec:lint` | The contract meets the house rules and your own (Spectral) |
| `task spec:compat` | Changes since the last published contract are listed and `info.version` is bumped to match |
| `task mock` | Serve a mock of the contract on http://127.0.0.1:4010 - no implementation needed |
| `task http` | Send requests from `http/*.http` to the mock, the local stack or a deployed API |
| `task typecheck` | The code agrees with the types generated from the contract |
| `task test:unit` | Unit tests, including "every contract operation has a handler" |
| `task acceptance` | Features, then fuzz, against one stack - what `task ci` runs |
| `task features` | The feature files, strict, against the built Lambda on AWS Emulator. `task features -- --tags @operation:create_thing` runs a subset |
| `task contract:fuzz` | schemathesis generates requests from the contract (fixed seed) and checks every response conforms |
| `task dev` | The API on http://127.0.0.1:3000 against AWS Emulator |
| `task build` | Bundle the Lambda into `dist/` |
| `task infra:validate` | Terraform format and validation |
| `task deploy` / `task destroy` | Apply or remove the stack on AWS (opt-in) |
| `task aws:bootstrap` | One-off: create the state bucket and GitHub deploy role in your AWS account (opt-in) |

## Layout

```
specs/
  openapi.yaml          the contract            ← you write
  features/             the behaviour           ← you write
src/
  operations/           one file per operation  ← implemented from the spec
  handler.ts            the Lambda entry point
  lib/                  router, contract validation, problem responses, DynamoDB client
  generated/            types, runtime contract, route table (task generate; not committed)
steps/
  world.ts              HTTP client that holds every response to the contract
  *.ts                  step definitions        ← implemented from the spec
local/                  AWS Emulator runner, Terraform apply, API Gateway stand-in
infra/                  Terraform: Lambda, HTTP API, DynamoDB
infra/bootstrap/        opt-in, one-off: state bucket and GitHub deploy role
rules/house.yaml        contract standards shared by every API
.spectral.yaml          contract rules for this API ← you add
http/                   .http requests for exploring by hand; contract.http is generated
scripts/                generate, scaffold, spec:check and http:generate
.claude/skills/write-spec/      the skill that helps you write the spec
.claude/skills/implement-api/   the skill that drives an implementation
```

## The gates

Each gate fails for one reason and says what it is:

- **`spec:check`** - no operations, an operation without an `operationId`, an
  operation no scenario is tagged for, or a tag naming an operation that does
  not exist.
- **`spec:lint`** - the contract breaks a rule in `rules/house.yaml` or
  `.spectral.yaml`. Warnings fail as well as errors.
- **`spec:compat`** - the contract changed since the last published one and
  `info.version` does not say so: a breaking change without a new major
  version, an API change without a new minor, or an edit without a new version.
- **`http:check`** - `http/contract.http` no longer matches the contract; run
  `task http:generate` and commit it.
- **`test:unit`** (`test/routes.test.ts`) - an operation in the contract with
  no file in `src/operations/`, or one that is still the stub `task scaffold`
  wrote.
- **`features`** - an undefined step, a failed assertion, or *any* response
  whose status, content type or body is not what the contract documents for
  that operation.
- **`contract:fuzz`** - a generated request that produced a 5xx, an
  undocumented status, or a body that does not match its schema. The seed is
  fixed, so a failure reproduces.

The router validates every incoming request against the contract before your
code runs, so the 400 responses are the contract's, not hand-written checks.

## Writing and changing the spec

**Writing it.** The `write-spec` skill (`.claude/skills/write-spec`) helps
you get from requirements to a spec. You own the requirements: it asks what
the API is for, who uses it and what the rules are, proposes the conventional
parts, and writes only what you have confirmed. It writes the features first,
then a contract that carries exactly that behaviour, runs the spec gates, and
has you try the result on the mock before you approve it. It stops there;
`/implement-api` builds it.

**Changing it.** A published contract has consumers, so every change is
versioned. `info.version` is a semantic version, and `task spec:compat` - a
gate in `task ci` - holds it to what actually changed:

| The change | Examples | `info.version` needs |
| --- | --- | --- |
| Breaking - an existing consumer can fail | Removing or renaming an operation, property or enum value; a new required request property; a tighter limit | A new **major** (a new minor while the API is `0.x`) |
| Additive - existing consumers are unaffected | A new operation, a new optional request property, a new response property | A new **minor** |
| Clarifying - the API behaves the same | Descriptions, examples | A new **patch** |

The gate compares the contract with the last published one using
[oasdiff](https://github.com/oasdiff/oasdiff): on a branch, the contract on
the default branch; on the default branch, the previous commit. It prints
every change, grouped by whether it breaks consumers, and fails if the
version does not match. So a breaking change cannot be merged by accident: it
is listed in the CI log and needs a deliberate major version.

```sh
task spec:compat                         # against the default branch / previous commit
SPEC_BASELINE=v1.4.0 task spec:compat    # against any tag, branch or commit
```

Prefer not to break: add the new thing beside the old, mark the old
`deprecated: true`, and remove it in a later major version. The gate checks
the contract's version; how you serve two major versions side by side, if
you need to, is a deployment decision the template leaves to you.

## Contract standards

`task spec:lint` runs [Spectral](https://github.com/stoplightio/spectral)
over `specs/openapi.yaml`. It is a gate in `task ci`, so a contract that
breaks a rule cannot be implemented green.

**House rules** (`rules/house.yaml`) ship with the template and apply to every
API, on top of Spectral's built-in OpenAPI rules:

| Rule | Standard |
| --- | --- |
| Naming | Property names, path and query parameters, `operationId`s, path segments and string enum values are **lower snake_case** (`created_at`, `beer_id`, `create_beer`, `/beer_styles`) |
| Schema names | PascalCase - they become TypeScript type names |
| Operations | Every operation has an `operationId` and a `summary`, and documents a `400` |
| Errors | Every 4xx/5xx response is `application/problem+json` |
| Request bodies | Object bodies set `additionalProperties: false` |

**Your rules** go in `.spectral.yaml`, which extends the house rules. Add what
is specific to your API or organisation - versioning, security schemes,
documentation requirements - using any
[Spectral rule](https://docs.stoplight.io/docs/spectral/d3482ff0ccae9-rules):

```yaml
extends: ["./rules/house.yaml"]

rules:
  property-description-required:
    description: Every property is described.
    severity: error
    given: "$..properties[*]"
    then:
      field: description
      function: truthy
```

Treat `rules/house.yaml` as part of the skeleton: change a house standard in
the template, once, not in one API.

## Try the contract before it is built

In the spec phase there is nothing to run yet, but a contract is easier to
judge by calling it than by reading it. `task mock` starts
[Prism](https://github.com/stoplightio/prism), which serves
`specs/openapi.yaml` as a mock API:

```sh
task mock                       # http://127.0.0.1:4010, answers from the contract's examples
task mock -- --dynamic          # generate varied data from the schemas instead
MOCK_PORT=4011 task mock

curl http://127.0.0.1:4010/things
curl -X POST http://127.0.0.1:4010/things -H 'content-type: application/json' -d '{}'
curl http://127.0.0.1:4010/things/123 -H 'Prefer: code=404'   # ask for a documented response
```

It validates each request against the contract and answers with a documented
response, so a consumer can build against it while the API is being
implemented. It is a mock: it holds no data and knows none of the behaviour
in the feature files - something you create is not there when you list. Good
examples in the contract make it far more useful.

Prism is not a gate and is not installed with the project; the task fetches
the version pinned in `Taskfile.yml` the first time you run it.

## Exploring the API by hand

For poking at the API - as opposed to testing it - the template uses plain
`.http` files and [httpYac](https://httpyac.github.io) to send them. A
`.http` file is just the request as text, so it diffs, reviews and lives in
the repository like any other source, and the same file works from the
command line, in VS Code (the httpYac extension) and in JetBrains IDEs (the
built-in HTTP client).

You do not have to write any to start: `http/contract.http` is generated from
the contract, with one ready-to-send request per operation, filled in from
the contract's examples.

```sh
task http                      # pick a request and send it to the local stack (run `task dev` first)
ENV=mock task http             # ...to the mock instead (run `task mock` first) - works in the spec phase
ENV=aws task http              # ...to a deployed stack
task http -- --name create_thing     # one request, by operationId
task http -- --all                   # every request in turn
```

| Environment | Sends to | Caller |
| --- | --- | --- |
| `mock` | Prism, `http://127.0.0.1:4010` | `test:explorer` |
| `local` | the local stack, `http://127.0.0.1:3000` | `test:explorer` - the local stand-in for a signed-in caller |
| `aws` | your deployed API | a real token |

Environments are in `http/http-client.env.json`. For `aws`, put your stack's
`base_url` and a `token` in `http/http-client.private.env.json`, which is
never committed:

```json
{ "aws": { "base_url": "https://abc123.execute-api.eu-west-2.amazonaws.com", "token": "eyJ..." } }
```

`http/contract.http` is committed, so the requests can be read on GitHub and
run straight after cloning. When the contract changes, run
`task http:generate` and commit the result; `task ci` fails (`http:check`)
if the two have drifted. Keep requests of your own - a sequence that reproduces a bug, a
demo - in other files in `http/`; `task http` offers those too. These files
are for exploring. What the API must do belongs in a feature file, where it
is checked on every run.

## AWS Emulator

Local runs and CI use [AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html)
for DynamoDB. `local/stack.mjs` starts it, points the AWS SDK at it using the
credentials and certificate it writes to `~/.aws/emulator/<port>/`, runs the
task, and stops it. Emulated resources live in memory only.

- **Linux (and CI):** `task emulator:install` runs automatically. It downloads
  the pinned package, verifies AWS's signature and unpacks it into `.tools/` -
  nothing is installed system-wide.
- **Version:** pinned as `EMULATOR_VERSION` in `Taskfile.yml`, so every run
  tests against the same emulator. AWS publishes security fixes only in the
  latest release, so raise the pin regularly; published versions are listed in
  [versions.json](https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/versions.json).
- **macOS / Windows:** AWS ships no native package; run `task emulator:docker`
  in one terminal and the other tasks in a second. A running emulator is
  picked up automatically.
- **Port:** `EMULATOR_PORT` (default 9297).
- **Telemetry:** the emulator reports anonymous usage data to AWS by default.
  This template does not change that; set `EMULATOR_TELEMETRY=off` to turn it
  off ([details](https://docs.aws.amazon.com/emulator/latest/userguide/telemetry.html)).

### How close to production the tests are

Every run of `features`, `contract:fuzz` or `acceptance` builds this stack
from scratch and throws it away:

| Layer | In the tests | Same as production? |
| --- | --- | --- |
| Lambda code | `dist/handler.mjs`, the esbuild bundle Terraform packages | Yes - the same file |
| Infrastructure | `infra/` applied to AWS Emulator with `terraform apply` | Same definitions; the emulator's control plane, not AWS's |
| DynamoDB | The table that apply created, on AWS Emulator | Emulated |
| API Gateway | `local/server.ts` builds the payload-format-2.0 event from the contract's routes | Stand-in |
| Lambda runtime, IAM | Not exercised - the bundle runs in Node on the test machine | No |

The last two rows are a limit of the emulator, not a choice: it accepts the
Lambda and HTTP API definitions but cannot yet invoke a function. Until it
can, API Gateway, IAM and the Lambda runtime are only proven by a real deploy.

A new emulator release can change a response to match AWS more closely, which
is why the version is pinned; see
[how fidelity changes affect your tests](https://docs.aws.amazon.com/emulator/latest/userguide/versioning.html).

## Deploy

Terraform in `infra/` creates the Lambda (Node 22, arm64), an API Gateway HTTP
API with one route per contract operation, and a DynamoDB table. The API is
deployed without authentication; add an authorizer to the routes in
`infra/main.tf` before exposing anything that needs one.

Deploying is **opt-in**. Nothing in `task ci` touches AWS, and the template
works end to end without an AWS account.

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
   creates for the stack called `NAME`. If the account already has GitHub's
   OIDC provider, add `-- -var create_oidc_provider=false`. For a region other
   than eu-west-2, add `-- -var region=<region>`.

2. **Give GitHub the outputs.** The command prints four values. Add each as a
   repository **variable** (Settings → Secrets and variables → Actions →
   Variables). None of them is a secret.

   | Variable | What it is |
   | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | The role the job assumes. Setting this is what switches the job on. |
   | `AWS_REGION` | Where the stack is deployed |
   | `TF_STATE_BUCKET` | Where Terraform state is kept |
   | `STACK_NAME` | The `NAME` you bootstrapped |

3. **Push to `main`.** When `task ci` is green the `deploy` job runs
   `task deploy`; the API's URL is the `base_url` output at the end of its log.

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
| Local stack and CI | The stand-in enforces the same routes. A caller is `Authorization: Bearer test:<subject>`; in step definitions, set `this.caller = "<subject>"`. |
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

## Alerting

Every stack is deployed with the same baseline alarms (`infra/alarms.tf`).
They exist from the first deploy; you only choose where they notify.

| Alarm | Fires when | Usually means |
| --- | --- | --- |
| `<name>-lambda-errors` | Any Lambda error in 5 minutes | An unhandled error, a timeout or out of memory |
| `<name>-lambda-throttles` | Any throttled invocation in 5 minutes | The concurrency limit was reached |
| `<name>-lambda-duration` | p99 duration above 80% of the timeout for 15 minutes | Timeouts are about to start |
| `<name>-api-5xx` | Any 5xx response in 5 minutes | The API failed, or API Gateway could not reach the Lambda |
| `<name>-api-latency` | p99 latency above 3 seconds for 15 minutes | Callers are waiting |
| `<name>-table-throttles` | Any throttled DynamoDB read or write in 5 minutes | The table is refusing work |

Each alarm notifies when it fires and again when it recovers. Routing:

```sh
task deploy NAME=my-api -- -var alarm_email=oncall@example.com        # email; the address must confirm
task deploy NAME=my-api -- -var alarm_topic_arn=arn:aws:sns:...        # your existing topic instead
```

With neither, the alarms still exist and notify the stack's own topic
(`alarm_topic_arn` in the outputs), which you can subscribe a chat or on-call
tool to. In the CI deploy job, set the repository variables `ALARM_EMAIL` or
`ALARM_TOPIC_ARN`.

Thresholds are strict on purpose: a new API should be quiet, and an alarm you
learn to ignore is worse than none. The unexpected error behind a
`lambda-errors` or `api-5xx` alarm is in the logs with its `request_id`.
Alarms on business outcomes - orders failing, sign-ups dropping - are yours
to add; these cover the platform.

## Logging and CORS

- **Logging.** The router writes one JSON line per request - `request_id`,
  `route_key`, `operation_id`, `status`, `duration_ms` - and logs any
  unexpected error with the same `request_id`. Operations get the same logger
  as `context.log`, so their lines can be joined to the request in CloudWatch
  Logs Insights. `LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`)
  sets what is written; test runs use `warn` to keep their output readable.
- **CORS.** Off by default. To let browsers on other origins call the API,
  deploy with `-- -var 'cors_allowed_origins=["https://app.example.com"]'`.
  API Gateway answers the preflight requests itself; the local stand-in does
  not emulate CORS.

## Keeping dependencies current

`renovate.json` covers npm, GitHub Actions, Terraform providers and mise
tools, and raises the AWS Emulator and Prism versions pinned in
`Taskfile.yml`. Install the [Renovate app](https://github.com/apps/renovate)
on your repository to switch it on.

## Using this repository as a template

Create your repository with **Use this template** on GitHub. You only need
`main`: leave "Include all branches" unticked. The example branches are for
reading, not for building on.

Then, in your new repository:

- Delete `.github/rulesets/` and the "Branches" section of `CLAUDE.md`. Both
  describe how *this* repository keeps its example branches, not your API.
- Replace this README's top section with a description of your API. The rest
  is a working manual for the tooling and can stay.
- Change the copyright line in `LICENSE` if the code is not MIT or not yours
  to license that way.
- Add your spec and carry on from [Use it](#use-it). CI is red until the spec
  is implemented, and green from then on.

## Conventions the template assumes

- Request and response bodies are JSON.
- Errors are RFC 9457 `application/problem+json` (`Problem` in the contract).
- One DynamoDB table with string keys `pk` and `sk`, and two generic indexes
  (`gsi1`, `gsi2`, keyed on `gsi1pk`/`gsi1sk` and `gsi2pk`/`gsi2sk`) for
  listings and lookups the keys cannot serve. Defined once in `infra/main.tf`
  and created from it for local runs too.
