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

specs/features/*.feature ──► cucumber, strict, against the real handler
   (the behaviour)           running on AWS Emulator's DynamoDB
```

The same two files are both the instructions for building the API and the
tests that prove it was built. Nothing is mocked: the features call the Lambda
handler over HTTP through a local API Gateway stand-in, and the handler talks
to DynamoDB on [AWS Emulator](https://github.com/aws/aws-emulator).

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
3. **Implement it.** In [Claude Code](https://claude.com/claude-code), run:

   ```
   /implement-api
   ```

   The skill (`.claude/skills/implement-api`) reads the spec, writes the step
   definitions and operations, and works gate by gate until `task ci` is
   green. It may not edit `specs/`, weaken a gate or rebuild the skeleton. You can follow the same
   steps by hand - they are written out in the skill.
4. **Deploy.** `task deploy NAME=my-api` (see [Deploy](#deploy)).

## Tasks

`task` lists them. The ones you will use:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task spec:check` | The contract is valid and every operation has a tagged scenario |
| `task spec:lint` | The contract meets the house rules and your own (Spectral) |
| `task typecheck` | The code agrees with the types generated from the contract |
| `task test:unit` | Unit tests, including "every contract operation has a handler" |
| `task features` | The feature files, strict, against the Lambda on AWS Emulator. `task features -- --tags @operation:createThing` runs a subset |
| `task contract:fuzz` | schemathesis generates requests from the contract (fixed seed) and checks every response conforms |
| `task dev` | The API on http://127.0.0.1:3000 against AWS Emulator |
| `task build` | Bundle the Lambda into `dist/` |
| `task infra:validate` | Terraform format and validation |
| `task deploy` / `task destroy` | Apply or remove the stack on AWS |

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
local/                  API Gateway stand-in, table setup, AWS Emulator runner
infra/                  Terraform: Lambda, HTTP API, DynamoDB
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

## AWS Emulator

Local runs and CI use [AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html)
for DynamoDB. `local/stack.mjs` starts it, points the AWS SDK at it using the
credentials and certificate it writes to `~/.aws/emulator/<port>/`, runs the
task, and stops it. Emulated resources live in memory only.

- **Linux (and CI):** `task emulator:install` runs automatically. It downloads
  the package, verifies AWS's signature and unpacks it into `.tools/` - nothing
  is installed system-wide.
- **macOS / Windows:** AWS ships no native package; run `task emulator:docker`
  in one terminal and the other tasks in a second. A running emulator is
  picked up automatically.
- **Port:** `EMULATOR_PORT` (default 9297).
- **Telemetry:** the emulator reports anonymous usage data to AWS by default.
  This template does not change that; set `EMULATOR_TELEMETRY=off` to turn it
  off ([details](https://docs.aws.amazon.com/emulator/latest/userguide/telemetry.html)).

Only DynamoDB is emulated. API Gateway is stood in for by `local/server.ts`,
which builds the same payload-format-2.0 event from the same contract routes
and invokes the real handler.

## Deploy

Terraform in `infra/` creates the Lambda (Node 22, arm64), an API Gateway HTTP
API with one route per contract operation, and a DynamoDB table.

```sh
task deploy NAME=my-api            # uses your AWS credentials; region defaults to eu-west-2
task deploy NAME=my-api -- -var region=eu-west-1
task destroy NAME=my-api
```

State is local by default - configure a backend in `infra/main.tf` before
sharing a stack. The API is deployed without authentication; add an authorizer
to the routes in `infra/main.tf` before exposing anything that needs one.

## Conventions the template assumes

- Request and response bodies are JSON.
- Errors are RFC 9457 `application/problem+json` (`Problem` in the contract).
- One DynamoDB table with string keys `pk` and `sk`, defined in
  `infra/main.tf` and mirrored for local runs in `local/table.ts`.
