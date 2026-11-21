# template-aws-api

[![template](https://github.com/hungovercoders/template-aws-api/actions/workflows/template.yml/badge.svg?branch=main)](https://github.com/hungovercoders/template-aws-api/actions/workflows/template.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Use this template](https://img.shields.io/badge/use%20this-template-2ea44f.svg)](../../generate)

**Describe your API. Get it built, tested and deployable on AWS.**

[Start here](#start-here) · [Architecture](#the-architecture-you-get) · [What you get](#what-you-get) ·
[Why a template](#why-a-template-not-a-prompt) · [How it works](#how-it-works) · [See it working](#see-it-working) ·
[Tasks](#everyday-tasks) · [By hand](#writing-the-spec-by-hand) · [Layout](#where-things-are) · [Guides](#guides)

A template for AWS Lambda APIs where you write only what makes the API
yours: what it does, in plain-language scenarios, and what it looks like, in
a contract. Everything else is already here, and an AI agent fills in the
business logic until every check passes.

You write this:

```gherkin
@operation:create_beer
Scenario: Adding a beer to the catalogue
  When staff add the beer "Morning After", an ipa at 5.6% abv
  Then the beer is added
  And the response says where to fetch the new beer
```

The agent writes the logic: one small function per operation, and the glue
for your sentences. From the example, shortened:

```ts
export async function create_beer({ body }: Context<"create_beer">) {
  const beer = { id: randomUUID(), name: body.name.trim(), style: body.style, abv: oneDecimal(body.abv) };
  await putNewBeer(beer);
  return json(201, toBeer(beer), { location: `/beers/${beer.id}` });
}
```

`task ci` then runs your scenarios against the real Lambda, on a local copy
of AWS, and says whether it is finished. Here it is running: a request, a
refusal, the event published and that event queried in S3 (real output, shortened).

![The example API on AWS Emulator: a beer is added, a bad request is refused with the reasons, the published event is shown, and the same event is read back from S3 with SQL](.github/images/api-in-action.gif)

## Start here

You need [mise](https://mise.jdx.dev). It installs everything else.

1. **Create your repository.** Click *Use this template* on GitHub, leave
   "Include all branches" unticked, then run `mise install`.
2. **Write the spec.** In [Claude Code](https://claude.com/claude-code), run
   `/write-spec`. It asks what the API should do, drafts the scenarios and
   contracts with you, and checks them. Prefer to write it yourself?
   [By hand](#writing-the-spec-by-hand).
3. **Make it yours.** Run `task adopt` once. It removes what is only about
   the template and replaces this README with one that describes your API.
4. **Have it built.** Run `/implement-api`. The agent generates what follows
   from the spec, writes the logic, and works until `task ci` is green. It
   may not edit your spec, weaken a check or rebuild the template.
5. **Deploy when you are ready.** `task deploy NAME=my-api`, or let CI deploy
   `main` ([Deploying](docs/deploying.md#deploy)). Nothing deploys until you
   opt in. To see the result first: [See it working](#see-it-working).

## The architecture you get

One service, every way in and out of it described by a contract:

```mermaid
flowchart TB
  caller(["API callers"]) <-->|"HTTP (OpenAPI)"| gateway["API Gateway"]
  sender(["Other services"]) -->|"messages (AsyncAPI)"| queue[["SQS queue"]]
  gateway --> api["Lambda: your operations"]
  queue --> consumer["Lambda: your consumers"]
  queue -.->|"after retries"| dlq[["Dead-letter queue"]]
  api --> table[("DynamoDB: your data and the outbox")]
  consumer --> table
  table -->|"stream"| forwarder["Lambda: forwarder"]
  forwarder -->|"events (AsyncAPI, CloudEvents)"| bus{{"EventBridge bus"}}
  bus --> subscriber(["Subscribers"])
  bus --> firehose["Firehose"] --> bucket[("S3: raw JSON, compacted daily to Parquet")]
  bucket -->|"data contract (ODCS)"| analyst(["Analysts: DuckDB, Harlequin"])
```

| Interface | Direction | Contract | Optional |
| --- | --- | --- | --- |
| HTTP API | in and out | `specs/openapi.v<N>.yaml` | no |
| Messages from a queue | in | `specs/asyncapi.v<N>.yaml`, `receive` | yes |
| Events on a bus | out | `specs/asyncapi.v<N>.yaml`, `send` | yes |
| Events as data in S3 | out | `specs/datacontract.v<N>.yaml` | yes |

Each part brings its Terraform, alarms, logs and tags. An API that does not
need an optional part removes it, and can bring it back later:
`task component:list`.

## What you get

**An HTTP API that holds to its contract**

- Routing, request validation and standard error responses (RFC 9457).
- Sign-in, from the contract's `security`.
- Types, the route table and a stub for every operation, generated.
- A mock of the contract your consumers can call before anything is built.

**Messages in, events out - only if you need them**

- A queue with retries and duplicate handling: one function per message.
- Events published with the change they describe: `outbox(event)` in a write.
- Those events kept in S3 and compacted daily to typed Parquet, both tested against a data contract, with DuckDB and Harlequin to query them.

**Tests that mean something**

- Your scenarios run against the built Lambda, through the stack your own
  Terraform created on [AWS Emulator](https://github.com/aws/aws-emulator).
  Nothing is mocked.
- Every response is checked against the contract, and the API is fuzzed.

**Ready for production**

- Terraform for the whole stack, with tags on every resource.
- Alarms, each with a runbook entry, and structured logs.
- CI on GitHub Actions, and deployment without stored keys.

## Why a template, not a prompt

Every API needs the same router, test harness, pipeline and Terraform. That
should be built once, not regenerated slightly differently by AI each time.

- **Known problems stay solved.** Asking an agent to work them out again
  costs tokens and review time on every project. AI works only on what is
  new: your business logic.
- **The spec is the prompt and the test.** The files that tell the agent what
  to build are run against what it built, so "done" has one answer.
- **Generate before you write.** Anything a command can derive from the spec
  comes from that command: identical every time, and it cannot drift.
- **Every API looks the same.** Seen one, seen them all.

If you catch yourself asking AI for a router, a test harness or a pipeline
here, stop: it exists. If something every API needs is missing, add it to
the template once, not to one API.

## How it works

```
specs/openapi.v<N>.yaml   ─┬─► request validation inside the Lambda
 (a file per live major)   ├─► types, the route table and a stub for every operation
                           ├─► API Gateway routes under /v<N> (Terraform reads them)
                           ├─► response validation on every call the features make
                           └─► generated fuzz requests (schemathesis)

specs/asyncapi.v<N>.yaml  ─┬─► every message and event validated as a CloudEvent
 (messages, events)        └─► a typed stub per message, a typed function per event

specs/datacontract.v<N>.yaml ─► per major: a stream, its retention, a freshness
 (events as data)               alarm (Terraform reads it), a test of what landed

specs/features/*.feature ──► cucumber, strict, against the built Lambda
   (the behaviour)           on infra/ applied to AWS Emulator
```

| You bring | The template has | The agent writes |
| --- | --- | --- |
| `specs/openapi.v<N>.yaml`, `specs/features/` | The Lambda, router, validation, harness, CI, Terraform | `src/operations/`, `steps/`, `src/domain/`, `src/store/` |
| `specs/asyncapi.v<N>.yaml`, if it has messages or events | The queue, the outbox, the event bus | `src/consumers/`, and `outbox(event)` in a write |
| `specs/datacontract.v<N>.yaml`: owner, retention, sensitivity | The bucket, delivery, the data test | |
| Who owns it: `domain` and `team` | Tags and a resource group | |

## See it working

The Beer Catalogue API is built on this template, one branch per step:

| Branch | What it is | `task ci` |
| --- | --- | --- |
| [`main`](../../tree/main) | The template, ready to use | Red - no spec yet |
| [`example/spec`](../../tree/example/spec) | The template and a complete spec | Red - not implemented yet |
| [`example/implementation`](../../tree/example/implementation) | That spec, delivered with `/implement-api` | Green |

Compare them:
[`main...example/spec`](../../compare/main...example/spec) is what a spec
looks like, and
[`example/spec...example/implementation`](../../compare/example/spec...example/implementation)
is what implementing one adds.

`task ci` on `example/implementation` (selected lines):

![task ci passing: every gate, 127 unit tests, 67 scenarios, the fuzz run and the data test](.github/images/task-ci.png)

> **CI on `main` is red on purpose.** There is no spec to build yet, so
> `task ci` fails until you add one. Changes to the template itself are
> proved by a separate check, `template`, which lays the example over them.

## Everyday tasks

Every command is a task. `task` lists them all; these are the ones you
start with:

| Task | What it does |
| --- | --- |
| `task ci` | Every check, in order. The definition of done; what CI runs |
| `task check` | The fast checks for the stage you have reached; `task hooks:install` runs it before every push |
| `task dev` | Your API on AWS Emulator, kept running; prints its URL and a token |
| `task http` | Send requests to the mock, the local stack or a deployed API |
| `task mock` | Serve a mock of the contract - no implementation needed |
| `task scaffold` | Write what follows from the spec: a stub per operation, a pending step per sentence |
| `task features` | Run the scenarios against the built Lambda |
| `task queue:send`, `task events:tail`, `task data:query` | Send a message, follow published events, query the events in S3 |
| `task deploy` | Apply the stack to AWS (opt-in) |

## Writing the spec by hand

`/write-spec` is the quick way. To do it yourself:

- Replace the starter `specs/openapi.v0.yaml` with your contract: paths under
  `/v0`, `operationId`s ending `_v0`, errors using its `Problem` schema.
- Add feature files to `specs/features/`, each scenario tagged with the
  operations it covers: `@operation:<operationId>`.
- Rules for this API alone go in `.spectral.yaml`
  ([Contract standards](docs/spec.md#contract-standards)).
- `task spec:check` says when the spec is complete enough to build from;
  `task spec:lint` that it meets the standards.
- `task mock` and `ENV=mock task http` let you and your consumers call the
  contract before anything is built
  ([Try the contract before it is built](docs/spec.md#try-the-contract-before-it-is-built)).

## Where things are

```
specs/                  the contracts and features/          ← you write
src/operations/         one file per operation               ← written from the spec
src/consumers/          one file per message received        ← written from the spec
src/domain/, src/store/ your rules and data access           ← written from the spec
steps/                  glue for your feature sentences      ← written from the spec
src/lib/, src/handler.ts  router, validation, DynamoDB, queue, outbox: the template's
infra/                  Terraform; tags.auto.tfvars.json     ← you say who owns it
local/                  runs the stack on AWS Emulator; the queue, event and data tasks
docs/                   one guide per reader; runbook.md for alarms
messages/, http/        examples of every message; requests to explore by hand
rules/, .spectral.yaml  contract standards: shared, and this API's ← you add
.claude/skills/         write-spec, implement-api, and AWS's own skills (skills.json)
scripts/, tools/        the generators and checks
AGENTS.md               instructions for coding agents
CONTRIBUTING.md         how the API is changed: spec first, then implementation
skeleton.lock, components.json  what the template is, and its optional parts
```

## Guides

| Guide | Read it when |
| --- | --- |
| [The spec](docs/spec.md) | Writing or changing the contract and feature files; standards; versioning; the mock |
| [Testing](docs/testing.md) | A check fails, or you want to run or explore the API locally |
| [Deploying](docs/deploying.md) | Putting an API on AWS; sign-in, CORS and CI deployment |
| [Runbook](docs/runbook.md) | An alarm has fired |
<!-- component:data:start -->
| [Events as data](docs/data.md) | The events are kept in S3: their data contract, querying them, and their alarms |
<!-- component:data:end -->

Changing an API built on this, or the template itself:
[CONTRIBUTING.md](CONTRIBUTING.md). Reporting a vulnerability:
[SECURITY.md](SECURITY.md). Change the copyright line in `LICENSE` if the
code is not MIT or not yours to license that way.
