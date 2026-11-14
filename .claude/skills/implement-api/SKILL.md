---
name: implement-api
description: Implement the AWS Lambda API described by the BDD feature files and OpenAPI contract in specs/, driven test-first by the template's deterministic gates until `task ci` is green. Use when asked to implement, build or deliver the API from feature files and an OpenAPI spec, or when specs/ has changed and the implementation must catch up.
---

# Implement the API from its features and contract

You are given two things, and they are the whole requirement:

- **`specs/openapi.yaml`** - the contract: every operation, request and response.
- **`specs/features/*.feature`** - the behaviour: what the API does, in business language.

If the user passes paths to these files instead (`/implement-api <openapi> <features dir>`),
copy them to `specs/openapi.yaml` and `specs/features/` first.

Your job is to make `task ci` green without changing what the specs say.
`task ci` is the definition of done - not your reading of the code.

## The skeleton is already built - do not build it again

This repository is a template. Everything that is the same for every API was
solved once and is already here: the Lambda entry point and router
(`src/handler.ts`, `src/lib/`), request validation, error responses, the
DynamoDB client, the local stack (`local/`), the test harness
(`steps/world.ts`), the gates (`Taskfile.yml`, `scripts/`, `test/routes.test.ts`),
CI and the Terraform (`infra/`).

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
   gate pass. If the two disagree, or a scenario is ambiguous or cannot be
   satisfied, stop and ask the user with the exact scenario and operation.
2. **Never weaken a gate.** The gates are how you find out whether you are
   right; they give the same answer every time. Do not edit `Taskfile.yml`, `cucumber.mjs`,
   `scripts/spec-check.ts`, `test/routes.test.ts`, `.github/workflows/ci.yml`
   or the contract checks in `steps/world.ts` and `src/lib/contract.ts`; do not
   skip, tag out or mark scenarios pending.
3. **Steps go through the front door.** Step definitions call the API with
   `this.call(...)` only - no importing `src/`, no reading the table. `call`
   already fails the step if a response breaks the contract, so steps assert
   behaviour (status, values, order), not shape.
4. **The contract does the validating.** The router validates every request
   against the contract before your operation runs and answers 400 itself.
   Do not re-validate in operations; implement only what the contract cannot
   express (uniqueness, existence, state rules).
5. **Errors are problems.** Throw `HttpProblem(status, title, detail)` from
   `src/lib/problem.ts`; only use statuses the contract documents for that
   operation.

## Workflow

Work in this order. Run the named gate after each step and read its output -
it tells you exactly what is missing.

1. **Read the specs.** Read `specs/openapi.yaml` and every feature file in
   full. List the operations (by `operationId`) and, for each, the scenarios
   tagged `@operation:<operationId>`.
2. **`task spec:check`** must pass before you write code. If it fails, the spec
   is incomplete (an operation with no scenario, an unknown tag, an invalid
   document) - report it to the user; do not fix the spec yourself.
3. **`task generate`** - produces `src/generated/api.d.ts` (types for every
   operation) and `src/generated/openapi.json` (the runtime contract).
4. **See it red.** Run `task test:unit`: `test/routes.test.ts` lists every
   operation with no handler. That list is your backlog.
5. **Write the step definitions** in `steps/<area>.ts`, binding every sentence
   in the feature files (`NODE_OPTIONS="--import tsx" npx cucumber-js --dry-run`
   shows undefined steps and offers snippets). Use `this.remembered` to carry
   records between steps of a scenario. Each scenario starts from an empty table.
6. **Implement one operation at a time**, simplest first:
   - `src/operations/<operationId>.ts` exporting
     `async function <operationId>(context: Context<"<operationId>">)` -
     `context.path`, `context.query` and `context.body` are typed from the
     contract and already validated.
   - Register it in `src/routes.ts` under its `operationId`.
   - Put rules that need no I/O in `src/domain/` with unit tests in `test/`,
     and DynamoDB access in `src/store/` using `dynamo` and `tableName` from
     `src/lib/dynamo.ts`. The table has string keys `pk` and `sk`; if you need
     an index, add it to both `infra/main.tf` and `local/table.ts`.
   - Run `task features -- --tags @operation:<operationId>` until its
     scenarios pass, then move on.
7. **`task features`** - every scenario green, strict.
8. **`task contract:fuzz`** - schemathesis sends generated requests, valid and
   invalid, and checks every response against the contract. A failure here is
   a real input your code mishandles (usually a 500, or a status the contract
   does not document): fix the code, never the check.
9. **`task ci`** - all gates, in CI order. Done only when this exits 0. Report
   the final output, and anything in the specs you had to interpret.

## What the gates prove

| Gate | Proves |
| --- | --- |
| `spec:check` | The contract is valid; every operation has a tagged scenario |
| `typecheck` | Operations agree with the types generated from the contract |
| `test:unit` | Every contract operation has a handler, and no extras; domain rules |
| `features` | The behaviour in the feature files, with every response held to the contract |
| `contract:fuzz` | Inputs nobody wrote a scenario for still get contract-conforming answers |
| `build`, `infra:validate` | The Lambda bundles and the Terraform is valid |
