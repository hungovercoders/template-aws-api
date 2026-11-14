---
name: implement-api
description: Implement the AWS Lambda API described by the BDD feature files and OpenAPI contract in specs/, driven test-first by the template's deterministic gates until `task ci` is green. Use when asked to implement, build or deliver the API from feature files and an OpenAPI spec, or when specs/ has changed and the implementation must catch up.
---

# Implement the API from its features and contract

You are given two things, and they are the whole requirement:

- **`specs/openapi.yaml`** - the contract: every operation, request and response.
- **`specs/features/*.feature`** - the behaviour: what the API does, in business language.

If the user passes paths to these files instead (`/implement-api <openapi> <features dir>`),
copy them to `specs/openapi.yaml` and `specs/features/` first. That is the
user supplying the spec, and the one time you write to `specs/`.

Your job is to make `task ci` green without changing what the specs say.
`task ci` is the definition of done - not your reading of the code.

## The skeleton is already built - do not build it again

This repository is a template. Everything that is the same for every API was
solved once and is already here: the Lambda entry point and router
(`src/handler.ts`, `src/lib/`), request validation, error responses,
authentication, logging, the DynamoDB client, the local stack (`local/`), the
test harness (`steps/world.ts`), the gates and generators (`Taskfile.yml`,
`scripts/`, `rules/`, `test/routes.test.ts`), CI and the Terraform (`infra/`).

You bring only the business logic the specs describe. That means you write:

- `steps/<area>.ts` - step definitions
- `src/operations/<operationId>.ts` and the entries in `src/routes.ts`
- `src/domain/`, `src/store/` and their unit tests in `test/`

Do not regenerate, restructure, "improve" or replace anything else, and do not
add a framework, another router, validator, test runner or build tool. If the
skeleton genuinely cannot express something the specs need (for example a
table index), make the smallest change and tell the user what you changed and
why - it is probably something the template should gain for every API.

## Rules

1. **`specs/` is read-only.** Never edit the contract or a feature file to make a
   gate pass. Tell two cases apart:
   - **The specs contradict each other, or a scenario cannot be satisfied** -
     stop and ask the user, quoting the scenario and the operation.
   - **The specs are silent** on a detail (whether a name is stored trimmed,
     whether a child record changes its parent's `updated_at`) - make the most
     reasonable choice, carry on, and list every such choice in your final
     report.
2. **Never weaken a gate.** The gates are how you find out whether you are
   right; they give the same answer every time. Do not edit `Taskfile.yml`, `cucumber.mjs`,
   `scripts/`, `rules/house.yaml`, `.spectral.yaml`,
   `test/routes.test.ts`, `.github/workflows/ci.yml`, `local/`
   or the contract checks in `steps/world.ts` and `src/lib/contract.ts`; do not
   skip, tag out or mark scenarios pending.
3. **Steps go through the front door.** Step definitions call the API with
   `this.call(...)` only - no importing `src/`, no reading the table. `call`
   already fails the step if a response breaks the contract, so steps assert
   behaviour - status, values, order, and what an error says is wrong - and
   leave the shape of bodies to the contract.
4. **The contract does the validating.** The router validates every request
   against the contract before your operation runs and answers 400 itself.
   Do not re-check in operations what the contract's schemas already say.
   Implement only what a schema cannot express: uniqueness, existence, state
   rules, and values that are opaque to the contract, such as a cursor that
   must be one this API issued. Answering 400 from an operation for those is
   right, when the contract documents 400.
5. **Errors are problems.** Throw `HttpProblem(status, title, detail)` from
   `src/lib/problem.ts`; only use statuses the contract documents for that
   operation.

## Workflow

Work in this order. Run the named gate after each step and read its output -
it tells you exactly what is missing.

1. **Read the specs.** Read `specs/openapi.yaml` and every feature file in
   full. List the operations (by `operationId`) and, for each, the scenarios
   tagged `@operation:<operationId>`.
2. **`task spec:check` and `task spec:lint`** must pass before you write code.
   If `spec:check` fails the spec is incomplete (an operation with no
   scenario, an unknown tag, an invalid document); if `spec:lint` fails the
   contract breaks a standard in `rules/house.yaml` or `.spectral.yaml`.
   Either way report the output to the user - do not fix the spec yourself,
   and never relax or disable a rule. If `task http:check` fails, the
   committed `http/contract.http` is out of date with the contract: run
   `task http:generate` and commit the file - it is generated, not spec.
3. **`task generate`** - produces `src/generated/api.d.ts` (types for every
   operation) and `src/generated/openapi.json` (the runtime contract).
4. **See it red.** Run `task test:unit`: `test/routes.test.ts` lists every
   operation with no handler. That list is your backlog.
5. **Write the step definitions** in `steps/<area>.ts`, binding every sentence
   in the feature files (`NODE_OPTIONS="--import tsx" npx cucumber-js --dry-run`
   shows undefined and ambiguous steps and offers snippets; it must report
   none). See [Writing steps](#writing-steps).
6. **Implement the operations, in dependency order.** Scenarios rarely use
   one operation: most need a "create" in a Given and a "get" or "list" in a
   Then. Start with the operations other scenarios depend on, then the rest.
   - `src/operations/<operationId>.ts` exporting
     `async function <operationId>(context: Context<"<operationId>">)`; see
     [Writing operations](#writing-operations).
   - Register it in `src/routes.ts` under its `operationId`.
   - Put rules that need no I/O in `src/domain/` and DynamoDB access in
     `src/store/`; see [Storing data](#storing-data).
   - `task features -- --tags @operation:<operationId>` runs the scenarios
     tagged for one operation. Expect them to stay red until the operations
     they also use exist.
7. **`task features`** - every scenario green, strict.
8. **`task contract:fuzz`** - schemathesis sends generated requests, valid and
   invalid, and checks every response against the contract. A failure here is
   a real input your code mishandles (usually a 500, or a status the contract
   does not document): fix the code, never the check. See
   [What the fuzzer sends](#what-the-fuzzer-sends).
9. **`task ci`** - all gates, in CI order. Done only when this exits 0. Report
   the final output, and every choice you made where the specs were silent.

## Writing operations

- **`context`** - `path`, `query` and `body` are typed from the contract and
  already validated. Path and query values are converted to the types the
  contract declares, and a `default` in the contract is filled in when the
  caller omits the parameter. `context.caller` is who is calling (see below);
  `context.log` writes structured lines - use it, not `console`. The router
  already logs every request and any unexpected error.
- **Answering** - return `json(status, body, headers?)` or `noContent()` from
  `src/lib/problem.ts`; the return type is `Result`. Set response headers such
  as `location` through `headers`. Throw `HttpProblem` for errors (rule 5).
- **Authentication** is already enforced for every operation the contract
  secures: never check tokens yourself. `context.caller` is always set on a
  secured operation and undefined otherwise; use it for rules about *what* a
  caller may do, and answer 403 with a problem when they may not.
- **Helpers** - shared code may sit beside what uses it: `src/operations/` for
  helpers shared by operations, `src/domain/` for rules. Only files named in
  `src/routes.ts` are operations.
- **Unit tests** go in `test/<name>.test.ts` (vitest). Test `src/domain/`.
  Do not unit-test `src/store/` with mocks: the features exercise it against
  DynamoDB on AWS Emulator, which is the test that counts.

### The 400 the router sends

Steps that assert *what* was wrong need to know its shape. A request that
breaks the contract gets `application/problem+json`:

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400,
  "detail": "The request does not satisfy the contract.",
  "errors": [{ "in": "body", "pointer": "/price", "message": "must be <= 20" }] }
```

`in` is `path`, `query` or `body`; `pointer` is a JSON pointer to the value
(`/name`, or `/thing_id` for a parameter). Two cases have an **empty**
`pointer` and name the field only in `message`: a missing required property
(`must have required property 'name'`) and an unexpected one
(`must NOT have additional properties`). An `HttpProblem` you throw has no
`errors`.

## Writing steps

- **`this.call(method, path, body?)`** sends the request, checks the response
  against the contract, and **returns** `{ status, headers, body }`. It also
  sets `this.last` - which a later call overwrites, so when a step makes
  several calls, or several at once with `Promise.all`, use the returned
  replies rather than `this.last`.
- **`this.remembered`** is a `Map` for anything a later step needs: a record a
  Given created (by name), the replies of concurrent calls, the query a "next
  page" step must repeat. Do not edit `steps/world.ts`.
- **Callers** - set `this.caller = "<subject>"` before a call to make it as
  that caller; leave it undefined to call anonymously. Subjects are letters,
  digits and `. _ @ -`. It only matters for operations the contract secures.
  A scenario about an anonymous caller often still needs a Given to set data
  up as a signed-in one: set `this.caller` for the Given's calls and restore
  it afterwards.
- **Each scenario starts from an empty table.**
- Step files are every `steps/**/*.ts`; a file of shared helpers there is fine.

## Storing data

Use `dynamo` (a DynamoDB document client) and `tableName` from
`src/lib/dynamo.ts`. The table (`infra/main.tf`) has string keys `pk` and
`sk` and two generic indexes, `gsi1` and `gsi2`: set `gsi1pk`/`gsi1sk` or
`gsi2pk`/`gsi2sk` on an item to put it in one. Both project every attribute,
so a Query on an index returns whole items.

- **Listing** - Query a key or an index; never Scan. To page, ask for one
  more item than the page size: its presence tells you there is a next page.
  A cursor should be opaque to callers and validated when it comes back
  (rule 4) - reject anything you could not have issued, with 400.
- **Consistency** - reads of the table can be strongly consistent
  (`ConsistentRead: true`); reads of an index cannot, on AWS. The emulator's
  indexes have behaved as immediately consistent, so list-after-write
  scenarios pass there. Listing from an index is the accepted trade-off; fetch a single item
  by key, consistently.
- **Atomic changes** - `TransactWriteCommand` is available, here and on the
  emulator, and is the way to keep several items in step (a record and the
  item that makes its name unique). A failed condition raises
  `TransactionCanceledException`, whose `CancellationReasons[i].Code` is
  `ConditionalCheckFailed` for the item that failed.
- **Concurrency** - any write, in or out of a transaction, can be refused
  because another transaction is touching the same item
  (`TransactionConflictException`, or the reason code `TransactionConflict`).
  Retry it. A write planned from a value you read earlier should carry a
  condition that the value is unchanged, and re-read and retry when it is not.
- **Expressions** - many attribute names are reserved words (`name`, `status`,
  `type`...). Always use `ExpressionAttributeNames`.

## What the fuzzer sends

Schemathesis generates whatever the contract allows, and a good deal it does
not. Before `task contract:fuzz`, check your code against:

- **Any text a string schema allows** - control characters, emoji, text that
  is all punctuation, very long values up to `maxLength`. Anything that ends
  up in a key must cope: a sort key is limited to 1024 bytes.
- **Numbers at the edges** - the minimum and maximum, `-0`, values with many
  decimal places, values too small for DynamoDB to store unless you round.
- **Random values for opaque strings** such as cursors and ids. They must get
  a documented 4xx, never a 500.
- **Every documented status is fair game** - if your code can answer with a
  status the contract does not document for that operation, that is a failure.

## Running the gates

`task` installs what it needs the first time: `task features`,
`task contract:fuzz` and `task acceptance` download AWS Emulator (Linux; needs
network, `dpkg-deb` and `gpgv`) and need `terraform`; the fuzzer needs `uvx`.
All come from `mise install`.

If the local stack cannot run where you are working, you can still run
`task spec:check`, `task spec:lint`, `task http:check`, `task typecheck`,
`task test:unit`, `task build` and the cucumber dry run, and you can call
`handler` from `dist/handler.mjs` directly with an API Gateway event to try
requests that are refused before they reach DynamoDB. That is not done: say
plainly in your report that the features and fuzz gates have not run, and
leave them to CI.

## What the gates prove

| Gate | Proves |
| --- | --- |
| `spec:check` | The contract is valid; every operation has a tagged scenario |
| `spec:lint` | The contract meets the house standards and this API's own rules |
| `typecheck` | Operations agree with the types generated from the contract |
| `test:unit` | Every contract operation has a handler, and no extras; domain rules |
| `features` | The behaviour in the feature files, with every response held to the contract |
| `contract:fuzz` | Inputs nobody wrote a scenario for still get contract-conforming answers |
| `infra:validate` | The Terraform is formatted and valid |
| `acceptance` | `features` and `contract:fuzz` together, against the built bundle on `infra/` applied to AWS Emulator - what `task ci` runs |
