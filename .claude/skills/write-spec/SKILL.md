---
name: write-spec
description: Work with the user to turn requirements into the spec for an AWS Lambda API built on this template - the OpenAPI contract in specs/openapi.yaml and the BDD feature files in specs/features - and to change that spec safely for the rest of the API's life. Use when asked to design, specify or define an API, and whenever an existing API should do something new, different or less, or has a bug - every such change starts here, before any code. Ends with a spec the gates accept and the user has approved; it does not implement.
---

# Write the spec with the user

The spec is the requirement. Everything downstream - types, routes, tests,
the implementation itself - is derived from it, so a wrong spec is built
faithfully. Your job is to help the user get it right.

Two outputs, and nothing else:

- **`specs/openapi.yaml`** - the contract: every operation, request and response.
- **`specs/features/*.feature`** - the behaviour: what the API does, in the
  user's business language.

Stop when the spec is done. Implementing it is the `implement-api` skill.

## Whose decision is what

**The user owns the requirements. You do not invent them.** A rule, a field,
a limit, a status, who may do what: each is in the spec because the user said
so or agreed when you proposed it.

- **Ask** when the answer changes what gets built: what the thing is for, who
  uses it, what they can do, the rules, what must never happen, what happens
  at the edges. Ask with `AskUserQuestion`, a few questions at a time, each
  with concrete options and your recommendation first.
- **Propose, then confirm** what follows from convention: resource and field
  names, status codes, pagination, error cases. Show the user what you
  chose; do not ask them to design it.
- **Decide** what the template already settles; see
  [What the template has decided](#what-the-template-has-decided). Do not ask
  about these.

Prefer a short round of good questions and a concrete draft the user can
react to over a long interview. People find requirements by seeing what is
wrong with a draft. Never fill a gap with a plausible guess and move on: if
you assumed something, say so and get a yes.

## Workflow

1. **Understand what exists.** Read `specs/openapi.yaml` and
   `specs/features/`. If the contract has operations, this is a *change* to a
   published spec: read [Changing a spec](#changing-a-spec) before anything
   else. If it is the starter (`paths: {}`), this is a new API.
2. **Find the requirements.** From what the user has said, work out and
   confirm:
   - the **things** the API is about, and what identifies each;
   - the **callers** - who they are, and which need to be signed in;
   - the **capabilities** - what each caller can do, as plain sentences
     ("staff retire a beer");
   - the **rules** - what must hold (uniqueness, limits, states, ordering),
     and what is refused and why;
   - the **edges** - empty, missing, duplicate, too many, at the same time.
   Play these back to the user as a short list before writing anything.
3. **Write the features first.** Behaviour in the user's words is what they
   can check; the contract's shape follows from it. See
   [Writing features](#writing-features).
4. **Write the contract** to carry exactly that behaviour. See
   [Writing the contract](#writing-the-contract).
5. **Run the gates** and fix what they report - these failures are yours:
   - `task spec:check` - the contract is valid; every operation has a
     scenario tagged for it; secured operations document 401.
   - `task spec:lint` - the house rules (`rules/house.yaml`) and this API's
     own (`.spectral.yaml`). Do not relax or disable a rule; if the user
     wants a different standard, that is a change to the rules, made
     deliberately and separately.
   - `task spec:compat` - for a change: what it breaks, and whether
     `info.version` says so.
   - `task http:generate`, then `task http:check` - the requests for
     exploring match the contract.
   - `task readme:generate`, then `task readme:check` - the README describes
     this API; see [The repository becomes the API](#the-repository-becomes-the-api).
6. **Let the user try it.** `task mock` serves the contract; `ENV=mock task
   http` sends a request for each operation. Ask the user to try it, or walk
   them through the responses. This is where missing requirements surface.
7. **Check every rule has a scenario.** Go through the confirmed list from
   step 2: each capability, rule and edge is a scenario, and each scenario
   traces to something the user confirmed. Remove what does not.
8. **Get the user's approval** of the final spec, with a summary: the
   operations, who may call each, the rules, and every assumption you made.
   Then stop. Tell them `/implement-api` builds it.

## The repository becomes the API

A repository created from the template describes the template. Once it has a
spec it is an API, and should say so. Most of that is generated:

- **`task readme:generate`** writes the README's API section from the
  contract - title, description, version, every operation and who may call
  it. The first time, it replaces the template's README entirely. Run it
  whenever the contract changes and commit the result; never edit the
  generated block. This is why `info.title`, `info.description` and each
  operation's `summary` matter: they are the API's front page. Write them for
  someone who has never heard of it.
- **The `## Notes` section** under the generated block is for what the
  contract cannot say. Ask the user for it - why the API exists, who owns it,
  where it is deployed - and write only what they tell you.

The first time a spec is written in a repository created from the template,
run **`task adopt`**, after confirming with the user. It removes what is only
about the template - its self-test workflow, its branch ruleset, and the
sections marked template-only in `CONTRIBUTING.md`, `SECURITY.md`,
`AGENTS.md` and the pull request template - names `AGENTS.md` after the API,
and writes the README. Do not do any of that by hand. Afterwards ask the user
whether the `LICENSE` copyright line is right.

What remains is the API's own, and stays true for its whole life:
`CONTRIBUTING.md` (every change goes spec first, then implementation), the
guides in `docs/`, and these skills.

## Writing features

- **One feature file per capability or concern** (`catalogue.feature`,
  `ratings.feature`), with a short description of who it is for and why.
- **Business language, not HTTP.** "Then the beer is added", not "Then the
  response is 201". No paths, status codes, JSON or field names in the
  sentences - those belong to the contract, and the step definitions map
  one to the other.
- **One behaviour per scenario**, named for the rule it proves ("Two beers
  cannot share a name"). Given the situation, When one thing happens, Then
  what is true.
- **Cover the rule, its refusal and its edges**: the success, each way it is
  refused, and the boundary values. Use a `Scenario Outline` for a rule with
  several values.
- **Tag every scenario** with the operations it exercises:
  `@operation:<operationId>`. Every operation needs at least one.
- **Reuse sentences.** The same action is worded the same way everywhere;
  each distinct sentence is a step someone has to implement.
- **Independent scenarios.** Each starts from nothing; a `Background` or
  Givens set up what it needs.
- If signing in matters, say who is acting in the sentence ("staff ...",
  "someone who is not signed in ..."), and cover both sides.
- If things can happen at the same time (two people changing one record),
  write scenarios for what must still hold.

## Writing the contract

- **Start from `specs/openapi.yaml` as it is.** It carries the `Problem`
  schema and reusable error responses the template's router produces.
- **`operationId`** names the operation everywhere - the handler, the file,
  the tag in the features. Lower snake_case, verb first: `create_beer`.
- **Every operation** has a `summary`, a `400` response, and a response for
  every outcome a scenario describes. If a scenario says a request is
  refused, the contract documents that status for that operation.
- **Be exact about data.** Types, formats, enums, minimum and maximum,
  lengths, which properties are required. Request bodies set
  `additionalProperties: false`. The router enforces all of it, so a
  constraint in the contract is a rule that needs no code - prefer it to a
  rule only a scenario states.
- **Examples everywhere** - on request bodies and responses. The mock and the
  generated `.http` requests answer with them.
- **Authentication** - declare `security` on the operations that need a
  signed-in caller (see the commented block in the starter contract) and
  document `401` on each.
- **Lists** - anything that can grow is paged: a `limit`, a `cursor`, and a
  `next_cursor` in the response. Say what the order is.
- **`info.version`** is a semantic version. A new API starts at `0.1.0`.

## What the template has decided

Do not ask the user about these; apply them.

- JSON requests and responses.
- Errors are RFC 9457 `application/problem+json` using the `Problem` schema,
  except `401`, which API Gateway answers as `application/json` with a `message`.
- Names are lower snake_case: properties, parameters, `operationId`s, path
  segments, string enum values. Schema names are PascalCase.
- Authentication is a bearer JWT verified by API Gateway.
- A request that breaks the contract gets `400` from the router.

## Changing a spec

Every change to the API for the rest of its life starts here: a new feature,
a changed rule, a removal, and a bug fix alike. A **bug** is a scenario that
is missing or wrong - write the scenario that shows the correct behaviour
(it will fail against the current code), and change the contract only if its
shape was wrong too.

A published contract has consumers. Treat every change as one of three
kinds, and tell the user which theirs is before you make it:

| Kind | Examples | `info.version` |
| --- | --- | --- |
| **Breaking** - an existing consumer can fail | removing or renaming an operation, property or enum value; a new required request property; a tighter limit; a different status | new **major** (while the API is `0.x`, a new minor) |
| **Additive** - existing consumers are unaffected | a new operation; a new optional request property; a new response property | new **minor** |
| **Clarifying** - the API behaves the same | descriptions, examples, summaries | new **patch** |

- `task spec:compat` decides which it is, deterministically, by comparing
  with the last published contract; it lists each breaking change and fails
  until `info.version` matches. Run it after every edit to the contract. Do
  not argue with its list - if it says breaking, it is.
- **A breaking change is the user's decision, not yours.** Show them the
  list and the consumers it affects, and offer the additive alternative
  first: add the new thing beside the old, mark the old `deprecated: true`,
  and remove it in a later major version. Only bump the major when they
  choose to break.
- Change the features with the contract: update the scenarios the change
  affects, add scenarios for new behaviour, and delete scenarios only for
  behaviour the user has agreed to remove.
- Regenerate and commit `http/contract.http` (`task http:generate`).
- After the spec changes, the implementation is behind: `task ci` fails
  until `/implement-api` catches it up.
