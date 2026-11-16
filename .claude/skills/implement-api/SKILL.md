---
name: implement-api
description: Implement, or bring up to date, the AWS Lambda API described by the BDD feature files and the contracts in specs/ (OpenAPI for HTTP; where present, AsyncAPI for messages and events and a data contract for events kept in S3), driven test-first by the template's deterministic gates until `task ci` is green. Use for the first build from a spec and for every change after it - whenever specs/ has changed (a new operation, a changed rule, a bug's failing scenario, something removed) and the implementation must catch up.
---

# Implement the API from its features and contract

You are given the spec, and it is the whole requirement:

- **`specs/features/*.feature`** - the behaviour: what the API does, in business language.
- **`specs/openapi.yaml`** - the HTTP contract: every operation, request and response.
- **`specs/asyncapi.yaml`** and **`specs/datacontract.yaml`**, where the API
  has them: the messages it takes, the events it publishes, and those events
  as data. Workflow step 1 says what to read for each.

If the user passes paths to these files instead (`/implement-api <openapi> <features dir>`),
copy them to `specs/openapi.yaml` and `specs/features/` first. That is the
user supplying the spec, and the one time you write to `specs/`.

Your job is to make `task ci` green without changing what the specs say.
`task ci` is the definition of done - not your reading of the code.

## Generate before you write

**Anything a command can derive from the specs is produced by that command,
never written by you**: generated output is the same every time and cannot
drift from the spec. Your judgement is for what no tool can derive - the
behaviour inside each operation and each step.

| Derived from the specs by a command | Command |
| --- | --- |
| Types for every operation, request and response | `task generate` |
| The runtime contract the router validates against | `task generate` |
| The route table wiring each `operationId` to its function | `task generate` |
| A typed file for every operation, answering 501 until implemented | `task scaffold` |
| A typed pending step for every sentence in the feature files | `task scaffold` |
| A request for every operation, for exploring by hand | `task http:generate` |
<!-- component:asyncapi:start -->
| For `specs/asyncapi.yaml`: a typed stub per message received, a typed function per event published | `task scaffold`, `task generate` |
<!-- component:asyncapi:end -->

So: never write or edit a route table, a type that mirrors the contract or an
operation's signature by hand, and never write a step definition from
scratch - start from the one `task scaffold` generated (merging and renaming
them is expected; see workflow step 5). Use the types from
`src/generated/api.d.ts` (`components["schemas"]["Thing"]`) rather than
declaring your own, and re-run the command when the specs change. Before
creating any file, ask whether a command already produces it. Something
mechanical that no command covers is a gap in the template: report it.

## The skeleton is already built - do not build it again

This repository is a template. Everything that is the same for every API was
solved once and is already here: the Lambda entry point and router
(`src/handler.ts`, `src/lib/`), request validation, error responses,
authentication, logging, the DynamoDB client, the local stack (`local/`), the
test harness (`steps/world.ts`), the gates and generators (`Taskfile.yml`,
`scripts/`, `rules/`, `test/routes.test.ts`), CI and the Terraform (`infra/`).

You bring only the business logic the specs describe. That means you write:

- the body of each step in `steps/` (`task scaffold` writes the outlines)
- the body of each operation in `src/operations/<operationId>.ts` (likewise)
<!-- component:consume:start -->
- the body of each consumer in `src/consumers/<operation>.ts` (likewise)
<!-- component:consume:end -->
- `src/domain/`, `src/store/` and their unit tests in `test/`

`task skeleton:check` enforces this: it is the first gate in `task ci` and
fails if any skeleton file differs from `skeleton.lock`. If it fails, undo
your change to the file it names. Never run `task skeleton:lock` yourself and
never edit `skeleton.lock` - accepting a skeleton change is the user's decision.

Do not regenerate, restructure, "improve" or replace anything else, or add a
framework, another router, validator, test runner or build tool. If the
skeleton cannot express something the specs need (a table index, say), make
the smallest change and tell the user what and why: the template may need it.

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
   right; they give the same answer every time. Do not edit `Taskfile.yml`,
   `cucumber.mjs`, `scripts/`, `tools/`, `rules/`, `.spectral*.yaml`,
   `test/routes.test.ts`, `.github/workflows/`, `local/`
   or the contract checks in `steps/world.ts` and `src/lib/contract.ts`; do not
   skip, tag out or mark scenarios pending.
3. **Steps go through the front door.** Step definitions call the API with
   `this.call(...)` only - no reading the table, no importing `src/` (a type
   included: the harness in `steps/` exports them). `call`
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
   tagged `@operation:<operationId>`. Read `skills.json`: use its skills
   where they fit, and ask the user before adding one for an integration that
   has none (`task skills:add`); never add one unasked.
   <!-- component:consume:start -->
   For a `receive` operation in `specs/asyncapi.yaml`, also follow [messages.md](messages.md).
   <!-- component:consume:end -->
   <!-- component:publish:start -->
   For a `send` operation there, also follow [events.md](events.md).
   <!-- component:publish:end -->
   <!-- component:data:start -->
   With a `specs/datacontract.yaml`, also read [data.md](data.md).
   <!-- component:data:end -->
2. **`task spec:check` and `task spec:lint`** must pass before you write code.
   If `spec:check` fails the spec is incomplete (an operation with no
   scenario, an unknown tag, an invalid document); if `spec:lint` fails the
   contract breaks a standard in `rules/house.yaml` or `.spectral.yaml`.
   Either way report the output to the user - do not fix the spec yourself,
   and never relax or disable a rule. The same goes for `task spec:compat`:
   a failure there is a contract change that is not versioned, which is the
   user's to resolve (the `write-spec` skill covers it). If `task http:check`
   or `task readme:check` fails, a committed file generated from the contract
   is out of date: run `task http:generate` or `task readme:generate` and
   commit the result.
3. **`task scaffold`** - generates the types, runtime contract and route
   table (`src/generated/`), then writes a typed stub for every operation
   that has no file (`src/operations/<operationId>.ts`) and a typed pending
   step for every sentence with no step definition (`steps/scaffold.ts`).
   It never overwrites, so re-run it whenever the specs change.
4. **See it red.** Run `task test:unit`: `test/routes.test.ts` lists the
   operations that are still stubs. That list is your backlog; an operation
   leaves it when you implement it and delete its `@scaffold` line.
5. **Implement the steps** `task scaffold` wrote. Each is one sentence from
   the feature files with its pattern and typed arguments; replace
   `return "pending"` with the calls and assertions, and give the arguments
   real names. The generator cannot tell that two sentences are one step, so:
   - sentences that differ only in wording ("a stout" / "an ipa", "1 rating" /
     "2 ratings") arrive as separate stubs - merge them into one pattern,
     with cucumber's alternation (`a/an`) and optional text (`rating(s)`);
   - a sentence with a variable number of values ("rated 5, 4 and 4") needs a
     regular expression instead of a cucumber expression;
   - check for ambiguity after merging - two patterns that both match a
     sentence fail the run.
   Move the steps into files of your own naming and delete
   `steps/scaffold.ts` when it is empty; commit your step files.
   `NODE_OPTIONS="--import tsx" npx cucumber-js --dry-run` (after
   `task scaffold`, which generates what the harness imports) must report
   no undefined and no ambiguous steps. See
   [Writing steps](#writing-steps).
6. **Implement the operations, in dependency order.** Scenarios rarely use
   one operation: most need a "create" in a Given and a "get" or "list" in a
   Then. Start with the operations other scenarios depend on, then the rest.
   - Fill in the stub in `src/operations/<operationId>.ts` and delete its
     `@scaffold` line; keep the generated signature. See
     [Writing operations](#writing-operations). There is nothing to register:
     the route table is generated.
   - Put rules that need no I/O in `src/domain/` and DynamoDB access in
     `src/store/`; see [Storing data](#storing-data).
   - `task features -- --tags @operation:<operationId>` runs the scenarios
     tagged for one operation. Expect them to stay red until the operations
     they also use exist.
7. **`task features`** - every scenario green, strict. First `task tags`:
   nothing is applied until `domain` and `team` are in
   `infra/tags.auto.tfvars.json`. Ask the user for one that is missing -
   never guess; `service` and `repo` are derived.
   `task acceptance` then runs `responses:check`: a response the contract
   documents that no scenario received is a gap in the spec, not the code.
   Report it to the user; do not write a scenario or drop the response yourself.
8. **`task contract:fuzz`** - schemathesis sends generated requests, valid and
   invalid, and checks every response against the contract. A failure here is
   a real input your code mishandles (usually a 500, or a status the contract
   does not document): fix the code, never the check. See
   [What the fuzzer sends](#what-the-fuzzer-sends).
9. **`task ci`** - all gates, in CI order. Done only when this exits 0. Then
   run `task stage -- implemented` and commit `.stage`, so the pre-push hook
   checks the code from now on. Report the final output, and every choice
   you made where the specs were silent.

## When the spec has changed

The same workflow serves every change after the first build. Behaviour never
changes in the code alone - if a change has no scenario, stop: it needs the
spec changed first (`write-spec`).

**Start by reading what changed:** `git diff <the commit the code was last
green at> -- specs`. A rule that changed while the contract kept its shape,
or a new row in a scenario outline, shows only when `task features` runs.

- **Something new** - `task scaffold` adds a stub for each new operation and
  a pending step for each new sentence, and touches nothing you have written.
  Implement them as in steps 5 and 6, in your existing step files; extend an
  existing pattern rather than add a near-duplicate of it.
- **Something changed** - nothing is scaffolded. `task features` goes red on
  the scenarios whose behaviour moved, and `task typecheck` on every use of a
  type the contract reshaped. Fix the code until both pass, and update any
  unit test in `test/` that states the old rule. Do not edit a scenario or
  the contract to match the code.
- **A bug** - the spec should now hold a scenario for it. If it fails, fix
  the code. If it passes once its steps exist, the bug is not reproduced:
  change no code and say so. Never fix a bug no scenario demonstrates.
- **Something removed** - `task typecheck` fails on the operation file whose
  `operationId` has left the contract, and `task steps:check` lists step
  definitions no sentence uses. Delete both, and any domain or store code
  only they used.
<!-- component:asyncapi:start -->
  A message no longer received and an event no longer published fail
  `task typecheck` too: in the consumer's file in `src/consumers/`, and where
  the event's function was called. Delete the file, or the `outbox(...)` item.
<!-- component:asyncapi:end -->
- **Data that is already stored** - scenarios start from an empty table, so
  no gate sees old items. When the contract gains a required response field,
  give items stored before it a value when they are read.

Afterwards the whole of `task ci` must pass, not only the gates you touched:
`http:check` and `readme:check` if the contract changed (regenerate and
commit), and `spec:compat`, which is the user's to resolve.

## Writing operations

- **`context`** - `path`, `query` and `body` are typed from the contract and
  already validated. Path and query values are converted to the types the
  contract declares, and a `default` in the contract is filled in when the
  caller omits the parameter. The generated type still marks such a parameter
  optional; assert it (`context.query.limit!`) rather than restating the
  default in code. `context.caller` is who is calling (see below);
  `context.log` writes structured lines - use it, not `console`. The router
  already logs every request and any unexpected error.
- **Answering** - return `json(status, body, headers?)` or `noContent()` from
  `src/lib/problem.ts`; the return type is `Result`. Set response headers such
  as `location` through `headers`; a `location` is a path from the API's root
  (`/things/<id>`), which a step can pass straight to `this.call`. Throw
  `HttpProblem` for errors (rule 5).
- **Authentication** is already enforced for every operation the contract
  secures: never check tokens yourself. `context.caller` is always set on a
  secured operation and undefined otherwise; use it for rules about *what* a
  caller may do, and answer 403 with a problem when they may not.
- **Helpers** - shared code may sit beside what uses it: `src/operations/` for
  helpers shared by operations, `src/domain/` for rules. Only a file named
  after an `operationId` is an operation.
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
- **`this.remembered`** is a `Map<string, any>` for anything a later step needs: a record a
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

Use `dynamo` and `tableName` from `src/lib/dynamo.ts`; the table and its two
indexes are the skeleton's. Before writing `src/store/`, read
[store.md](store.md): listing and paging, what is consistent, atomic changes,
and the retries a concurrent write needs.

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

`task` installs what it needs the first time, AWS Emulator included; the other
tools come from `mise install`. If the emulator will not start, connect or
sign, use the `aws-emulator` skill - but never upgrade it; its version is pinned.

The scenarios and the fuzz run call the API through AWS Emulator's API
Gateway, authorizer and Lambda - the built bundle is the function. Its Node
runtime is not the whole of Node, and a unit test cannot see the difference:

- no `node:http`, `node:https` or `node:module` - a dependency that needs
  one fails every request with `Runtime.ImportModuleError`;
- no `structuredClone`, and decoding malformed base64 throws: parse
  anything a caller supplies inside try/catch;
- it runs on the AWS SDK the runtime provides, so tell SDK errors by
  `error.name`, not `instanceof` ([store.md](store.md) has the rest).

When a task that uses the stack fails it prints what the functions logged,
errors first (it needs the AWS CLI): read that before guessing why a request
answered 500. `task emulator:gaps:list` names what else the emulator cannot
do yet; read it before deciding the emulator, not your code, is at fault.

If the local stack cannot run where you are working, `task check`,
`task build`, `task infra:validate` and the cucumber dry run still do, and
`handler` from `dist/handler.mjs` can be called with an event. That is not
done: say so in your report, and leave the features and fuzz gates to CI.

## What the gates prove

Each gate fails for one reason and says what it is; `docs/testing.md` lists
them all under "The gates".
