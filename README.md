# template-aws-api

**Bring your own business logic.** Everything every Lambda API needs - routing,
request validation, error responses, the DynamoDB client, local emulation, the
test harness, CI, infrastructure, deployment - is solved here once. The only
thing you bring is what makes your API *yours*: BDD feature files that say what
it does and an OpenAPI contract that says what it looks like.

> **This is the `example/implementation` branch: the example spec, delivered.**
> The Beer Catalogue API from [`example/spec`](../../tree/example/spec),
> implemented by following the `implement-api` skill. `specs/` and the
> template's gates are untouched; the
> [diff from `example/spec`](../../compare/example/spec...example/implementation)
> is the step definitions, the operations and their unit tests. **CI is green.**

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

Every command is a task. `task` lists them all, each with a one-line
description; these are the ones you start with:

| Task | What it does |
| --- | --- |
| `task ci` | Every gate, in order. The definition of done; what CI runs. |
| `task scaffold` | Write what follows from the spec: a typed stub per operation, a pending step per sentence |
| `task mock` | Serve a mock of the contract - no implementation needed |
| `task http` | Send requests to the mock, the local stack or a deployed API |
| `task features` | The feature files against the built Lambda on AWS Emulator |
| `task dev` | The API on http://127.0.0.1:3000 against AWS Emulator |
| `task deploy` | Apply the stack to AWS (opt-in) |

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
CONTRIBUTING.md         how the template itself is changed
SECURITY.md             how to report a vulnerability
skeleton.lock           what the skeleton is; skeleton:check fails if it changes
rules/house.yaml        contract standards shared by every API
.spectral.yaml          contract rules for this API ← you add
http/                   .http requests for exploring by hand; contract.http is generated
scripts/                generate, scaffold, spec:check and http:generate
.claude/skills/write-spec/      the skill that helps you write the spec
.claude/skills/implement-api/   the skill that drives an implementation
```

## Using this repository as a template

Create your repository with **Use this template** on GitHub. You only need
`main`: leave "Include all branches" unticked. The example branches are for
reading, not for building on.

Then, in your new repository:

- Delete `.github/rulesets/` and `.github/workflows/template.yml`, and
  replace `CONTRIBUTING.md` and `SECURITY.md` with your own. They describe
  how *this* repository is kept, tested and reported on, not your API.
- Replace this README's top section with a description of your API. The rest
  is a working manual for the tooling and can stay.
- Change the copyright line in `LICENSE` if the code is not MIT or not yours
  to license that way.
- Add your spec and carry on from [Use it](#use-it). CI is red until the spec
  is implemented, and green from then on.

## Guides

Each guide is for one reader at one moment. Read the one you need.

| Guide | Read it when |
| --- | --- |
| [The spec](docs/spec.md) | Writing or changing the contract and feature files; contract standards; versioning; the mock |
| [Testing](docs/testing.md) | A gate fails, or you want to run or explore the API locally |
| [Deploying](docs/deploying.md) | Putting an API on AWS; sign-in, CORS and CI deployment |
| [Runbook](docs/runbook.md) | An alarm has fired |

Changing the template itself: [CONTRIBUTING.md](CONTRIBUTING.md). Reporting a
vulnerability: [SECURITY.md](SECURITY.md).
