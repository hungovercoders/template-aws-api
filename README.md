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
> `test:unit`, listing the six operations that have no file yet. Running
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

Because `main` is red by design, skeleton changes get their green signal
from a separate check, `template`: it lays the example over the proposed
skeleton and runs every gate (`.github/workflows/template.yml`).

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
   [Using this repository as a template](docs/maintaining.md#using-this-repository-as-a-template))
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
     (see [Contract standards](docs/spec.md#contract-standards)).
   - `task spec:check` tells you when the spec is complete enough to build
     from, and `task spec:lint` that it meets the standards.
   - `task mock` serves the contract as a mock API, and `ENV=mock task http`
     sends it a request for each operation, so you and your consumers can
     call it and react to its shape before anything is built
     (see [Try the contract before it is built](docs/spec.md#try-the-contract-before-it-is-built)).
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
   machine, or bring your AWS account so CI deploys `main` (see [Deploy](docs/deploying.md#deploy)).

## Tasks

`task` lists them. The ones you will use:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task scaffold` | Write what follows from the spec: a typed stub per operation, a pending step per sentence |
| `task skeleton:check` | No skeleton file has changed since it was last accepted |
| `task docs:check` | Documents and agent context are within budget and their links resolve |
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
docs/                   guides, each for one reader at one moment; runbook.md for alarms
skeleton.lock           what the skeleton is; skeleton:check fails if it changes
rules/house.yaml        contract standards shared by every API
.spectral.yaml          contract rules for this API ← you add
http/                   .http requests for exploring by hand; contract.http is generated
scripts/                generate, scaffold, spec:check and http:generate
.claude/skills/write-spec/      the skill that helps you write the spec
.claude/skills/implement-api/   the skill that drives an implementation
```

## Guides

Each guide is for one reader at one moment. Read the one you need.

| Guide | Read it when |
| --- | --- |
| [The spec](docs/spec.md) | Writing or changing the contract and feature files; contract standards; versioning; the mock |
| [Testing](docs/testing.md) | A gate fails, or you want to run or explore the API locally |
| [Deploying](docs/deploying.md) | Putting an API on AWS; sign-in, CORS and CI deployment |
| [Runbook](docs/runbook.md) | An alarm has fired |
| [Maintaining the template](docs/maintaining.md) | Creating a repository from the template, changing the skeleton, updating dependencies |
