# template-aws-api

**Bring your own business logic.** Everything every Lambda API needs - routing,
request validation, error responses, the DynamoDB client, local emulation, the
test harness, CI, infrastructure, deployment - is solved here once. The only
thing you bring is what makes your API *yours*: BDD feature files that say what
it does and an OpenAPI contract that says what it looks like.

> **This is the `example/spec` branch: the template plus a complete spec.**
> [`specs/openapi.yaml`](specs/openapi.yaml) is the contract for a Beer
> Catalogue API and [`specs/features/`](specs/features) is its behaviour.
> Nothing is implemented, so **CI is red on purpose** - `task ci` fails at
> `test:unit`, listing the six operations that have no handler. Running
> `/implement-api` here produces
> [`example/implementation`](../../tree/example/implementation).

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
- **Every API looks the same.** Same layout, same tasks, same gates, same
  deployment. Anyone - or any agent - who has seen one has seen them all.

| Solved once, in the template | You bring | AI resolves, checked by the gates |
| --- | --- | --- |
| Lambda entry point and router | `specs/openapi.yaml` - the contract | `steps/*.ts` - glue for your feature sentences |
| Request validation against the contract | `specs/features/*.feature` - the behaviour | `src/operations/*.ts` - one function per operation |
| RFC 9457 error responses | | `src/domain/`, `src/store/` - your rules and data access |
| Types generated from the contract | | |
| Local API Gateway stand-in + AWS Emulator | | |
| Contract-checking test harness, fuzzing | | |
| Contract linting to shared standards | | |
| mise, Taskfile, GitHub Actions CI | | |
| Terraform: Lambda, HTTP API, DynamoDB | | |

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
   (the contract)    ├─► TypeScript types for every operation
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

1. **Create your repo** from this template (*Use this template* on GitHub) and
   run `mise install`.
2. **Add your spec.**
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
   - `task mock` serves the contract as a mock API, so you and your consumers
     can call it and react to its shape before anything is built
     (see [Try the contract before it is built](#try-the-contract-before-it-is-built)).
3. **Implement it.** In [Claude Code](https://claude.com/claude-code), run:

   ```
   /implement-api
   ```

   The skill (`.claude/skills/implement-api`) reads the spec, writes the step
   definitions and operations, and works gate by gate until `task ci` is
   green. It may not edit `specs/`, weaken a gate or rebuild the skeleton. You can follow the same
   steps by hand - they are written out in the skill.
4. **Deploy, when you are ready.** Opt-in: `task deploy NAME=my-api` from your
   machine, or bring your AWS account so CI deploys `main` (see [Deploy](#deploy)).

## Tasks

`task` lists them. The ones you will use:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task spec:check` | The contract is valid and every operation has a tagged scenario |
| `task spec:lint` | The contract meets the house rules and your own (Spectral) |
| `task mock` | Serve a mock of the contract on http://127.0.0.1:4010 - no implementation needed |
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
  routes.ts             operationId → handler   ← implemented from the spec
  operations/           one file per operation  ← implemented from the spec
  handler.ts            the Lambda entry point
  lib/                  router, contract validation, problem responses, DynamoDB client
  generated/            types + runtime contract (task generate; not committed)
steps/
  world.ts              HTTP client that holds every response to the contract
  *.ts                  step definitions        ← implemented from the spec
local/                  AWS Emulator runner, Terraform apply, API Gateway stand-in
infra/                  Terraform: Lambda, HTTP API, DynamoDB
infra/bootstrap/        opt-in, one-off: state bucket and GitHub deploy role
rules/house.yaml        contract standards shared by every API
.spectral.yaml          contract rules for this API ← you add
scripts/                generate and spec:check
.claude/skills/implement-api/   the skill that drives an implementation
```

## The gates

Each gate fails for one reason and says what it is:

- **`spec:check`** - no operations, an operation without an `operationId`, an
  operation no scenario is tagged for, or a tag naming an operation that does
  not exist.
- **`spec:lint`** - the contract breaks a rule in `rules/house.yaml` or
  `.spectral.yaml`. Warnings fail as well as errors.
- **`test:unit`** (`test/routes.test.ts`) - an operation in the contract with
  no handler in `src/routes.ts`, or a handler for an operation that is not in
  the contract.
- **`features`** - an undefined step, a failed assertion, or *any* response
  whose status, content type or body is not what the contract documents for
  that operation.
- **`contract:fuzz`** - a generated request that produced a 5xx, an
  undocumented status, or a body that does not match its schema. The seed is
  fixed, so a failure reproduces.

The router validates every incoming request against the contract before your
code runs, so the 400 responses are the contract's, not hand-written checks.

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

## Conventions the template assumes

- Request and response bodies are JSON.
- Errors are RFC 9457 `application/problem+json` (`Problem` in the contract).
- One DynamoDB table with string keys `pk` and `sk`, and two generic indexes
  (`gsi1`, `gsi2`, keyed on `gsi1pk`/`gsi1sk` and `gsi2pk`/`gsi2sk`) for
  listings and lookups the keys cannot serve. Defined once in `infra/main.tf`
  and created from it for local runs too.
