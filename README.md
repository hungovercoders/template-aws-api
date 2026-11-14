# template-aws-api

A template for AWS Lambda APIs that are **driven by their spec**: BDD feature
files say what the API does, an OpenAPI contract says what it looks like, and
a set of deterministic gates will not go green until the implementation
delivers both.

> **CI on this branch is red on purpose.** `main` is the skeleton: no contract,
> no features, no implemented Lambda. `task ci` fails until you add a spec and
> implement it - that is the template working.

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
   - `task spec:check` tells you when the spec is complete enough to build from.
3. **Implement it.** In [Claude Code](https://claude.com/claude-code), run:

   ```
   /implement-api
   ```

   The skill (`.claude/skills/implement-api`) reads the spec, writes the step
   definitions and operations, and works gate by gate until `task ci` is
   green. It may not edit `specs/` or weaken a gate. You can follow the same
   steps by hand - they are written out in the skill.
4. **Deploy.** `task deploy NAME=my-api` (see [Deploy](#deploy)).

## Tasks

`task` lists them. The ones you will use:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task spec:check` | The contract is valid and every operation has a tagged scenario |
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
scripts/                generate and spec:check
.claude/skills/implement-api/   the skill that drives an implementation
```

## The gates

Each gate fails for one reason and says what it is:

- **`spec:check`** - no operations, an operation without an `operationId`, an
  operation no scenario is tagged for, or a tag naming an operation that does
  not exist.
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
