---
name: write-spec
description: Work with the user to turn requirements into the spec for an AWS Lambda API built on this template - the OpenAPI contract in specs/openapi.v<N>.yaml and the BDD feature files in specs/features, and where the API takes messages, publishes events or keeps them as data, the AsyncAPI contract and the data contract - and to change that spec safely for the rest of the API's life. Use when asked to design, specify or define an API, and whenever an existing API should do something new, different or less, or has a bug - every such change starts here, before any code. Ends with a spec the gates accept and the user has approved; it does not implement.
---

# Write the spec with the user

The spec is the requirement. Everything downstream - types, routes, tests,
the implementation itself - is derived from it, so a wrong spec is built
faithfully. Your job is to help the user get it right.

Its outputs, and nothing else:

- **`specs/features/*.feature`** - the behaviour: what the API does, in the
  user's business language, whichever way it is asked.
- **`specs/openapi.v<N>.yaml`** - the HTTP contract: every operation, request and
  response.
- **`specs/asyncapi.v<N>.yaml`** - where the API takes messages or publishes
  events - and **`specs/datacontract.v<N>.yaml`** - where it keeps those events as
  data. Each has a section below, present while the repository has that part.

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

1. **Understand what exists.** Run `task component:list` and see
   [Optional components](#optional-components). Read `specs/openapi.v<N>.yaml` and
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
   - the **edges** - empty, missing, duplicate, too many, at the same time;
   - the **integrations** - what else the API calls or is called by: a
     payment provider, an identity provider, another team's service. See
     [Skills for this API](#skills-for-this-api).
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
     exploring match the contract. Commit the regenerated file.
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
   Then run `task stage -- spec` and commit `.stage`: until the code catches
   up, the pre-push hook checks the spec and not the code. Stop there, and
   tell them `/implement-api` builds it.

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
- **Who owns it** is also on every AWS resource: when the user has said
  which business domain and which team own the API, record them as `domain`
  and `team` in `infra/tags.auto.tfvars.json`, so they are asked for once.
  Never guess either; `task tags` shows what is set.

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

## Optional components

The template carries parts not every API needs. `task component:list` names
them and says which this repository has; a component removed is restored
from the template, so removing one closes no door.

- **A new API.** Once the requirements are confirmed (step 2), tell the user
  which components they call for and which they do not, and ask which to
  keep. Remove the rest, each with `task component:remove -- <name>`, before
  writing the spec. The task refuses to remove one another still needs.
- **A change that needs one the repository removed** - "tell other teams when
  a beer is retired", in an API that kept only HTTP. Say so, and with the
  user's agreement run `task component:add -- <name>` first. If it reports the
  skeleton is behind the template, that is the user's to resolve; stop.

Never remove or restore a component the user has not agreed to, and never
write by hand what a removed component would have provided.

<!-- component:consume:start -->
## Messages the API receives

Work that arrives on a queue is specified like a request: a scenario says
what happens, and `specs/asyncapi.v<N>.yaml` (see `docs/spec.md`) says what the
message is, as a `receive` operation. Ask the user, and confirm:

- **what arrives and from whom** - name the message for what happened where
  it came from, in the past tense: "a rating was submitted";
- **what it carries**, and which of the API's existing rules apply to it. A
  message that does what a request does should follow the same rules;
- **what happens to one that can never be accepted** - it names something
  that does not exist. It is put aside on the dead-letter queue; say why;
- **that it may arrive twice.** A queue delivers at least once. Write the
  scenario: the same message twice takes effect once.

Write a scenario for each: accepted, delivered twice, breaking the contract,
and valid but never acceptable. Tag them `@operation:<operation>`. Then
`task asyncapi:check`, `asyncapi:lint` and `asyncapi:compat`, and
`task asyncapi:examples` for `messages/`; commit what it writes.

Order is not promised: a scenario must not depend on which of two messages
is handled first.
<!-- component:consume:end -->

<!-- component:publish:start -->
## Events the API publishes

What other services are told is specified too: a scenario says when an
event is published, and `specs/asyncapi.v<N>.yaml` says what it is, as a `send`
operation. Ask the user, and confirm:

- **what others need to know happened** - name each event for the thing and
  what happened to it, in the past tense: "a beer was retired" (type
  `...beer.retired.v1`, message and operations `_v1`). One event per thing;
- **what it carries.** Enough for a subscriber to act without calling back,
  and nothing private: an event is read by services you do not know. Every
  property is a promise, so start small; adding one later is not breaking;
- **when it is not published** - a request that was refused changes
  nothing, so it publishes nothing. Write that scenario;
- **who subscribes**, if they know: another AWS account needs to be let in
  (`event_subscriber_accounts`, `docs/deploying.md`). Tell them how a
  subscriber reads an event: on the bus it is inside EventBridge's own
  envelope, as `detail` (`docs/spec.md`).

State the promise to the user, because it is the template's and not theirs
to choose: an event is delivered at least once, and events about one thing
may arrive out of order. Put it in the contract's `info.description`.

Write a scenario for each event, tagged with its `send` operation and the
operation that causes it, and one for a refused request. Then
`task asyncapi:check`, `asyncapi:lint`, `asyncapi:compat` and
`asyncapi:examples`. A published event has subscribers: a breaking change
is a new type alongside the old one (`docs/spec.md`).
<!-- component:publish:end -->

<!-- component:data:start -->
## The events as data

Published events can also be kept in S3 under a data contract. Ask whether
the user wants that; if so, follow [data.md](data.md).
<!-- component:data:end -->

## Skills for this API

`skills.json` lists the skills in this repository. The template brings the
ones every API needs. What this API needs beyond them is the user's choice,
made once you know what the API does - settle it before step 8:

- **Offered by the template** (`offered` in `skills.json`). Each says when it
  earns its place. Tell the user which apply to this API and why, and add the
  ones they want: `task skills:add -- <name>`.
- **For what the API integrates with.** For each integration from step 2, ask
  the user whether a skill or tool for it exists and should be added - the
  provider's own, their organisation's, or none. From a git repository:
  `task skills:add -- <name> --repository <url> --path <dir>`. One of their
  own, written into `.claude/skills/<name>/`: `task skills:add -- <name> --manual`.
- **Record every integration** in `integrations` in `skills.json`, with the
  skill chosen, or `null` and why. `/implement-api` reads it and does not ask
  again, and a later reader sees it was considered:
  `{ "name": "Stripe", "skill": null, "note": "none wanted; uses the REST API" }`.

Never add a skill the user has not agreed to: it is context every later
session carries. Never edit a copied skill - `task skills:check` fails if one
is. Ask the user to check a skill's licence allows the copy.

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

- **Start from `specs/openapi.v0.yaml` as it is.** It carries the `Problem`
  schema and reusable error responses the template's router produces.
- **`operationId`** names the operation everywhere - the handler, the file,
  the tag in the features. Lower snake_case, verb first, its major last:
  `create_beer_v0`. Every path starts with that major: `/v0/beers`.
- **Every operation** has a `summary`, a `400` response, and a response for
  every outcome a scenario describes. If a scenario says a request is
  refused, the contract documents that status for that operation.
- **And the reverse:** every response you document needs a scenario that
  receives it - the 400, 401 and 404 included. `responses:check` fails the
  implementation otherwise, so check each operation's responses against the
  scenarios tagged for it before asking for approval.
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
- **`info.version`** is a semantic version whose major is the file's. A new API starts at `0.1.0`.

## What the template has decided

Do not ask the user about these; apply them.

- JSON requests and responses.
- Errors are RFC 9457 `application/problem+json` using the `Problem` schema,
  except `401`, which API Gateway answers as `application/json` with a `message`.
- Names are lower snake_case: properties, parameters, `operationId`s, path
  segments, string enum values. Schema names are PascalCase.
- Authentication is a bearer JWT verified by API Gateway.
- A request that breaks the contract gets `400` from the router.
<!-- component:asyncapi:start -->
- Every message and event is a CloudEvent 1.0 in structured JSON; a message
  that breaks the contract is put aside, never handled.
<!-- component:asyncapi:end -->

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
| **Breaking** - an existing consumer can fail | removing or renaming an operation, property or enum value; a new required request property; a tighter limit; a different status; **a rule that now gives a different answer** | a **new major file** beside the old (while the API is `0.x`, a new minor) |
| **Additive** - existing consumers are unaffected | a new operation; a new optional request property; a new response property | new **minor** |
| **Clarifying** - the API behaves the same | descriptions, examples, summaries | new **patch** |

One change often holds several kinds; the version follows the most serious.

- `task spec:compat` compares the spec with the last published one - on a
  branch, the default branch; on the default branch, the previous commit;
  `SPEC_BASELINE=<ref>` for anything else. If it reports "skipped" for an API
  that has been released, the baseline is wrong: set it. Run it after every
  edit.
- **What it says is breaking, is.** Do not argue with its list of contract
  changes.
- **What it cannot see, you must.** A rule can change while the contract's
  shape stays the same - the same field, a different answer. The gate lists
  every existing scenario that was changed or removed under "Existing
  behaviour changed". Each one is behaviour a consumer may rely on. Unless
  only the wording moved, treat it as breaking, tell the user so, and let
  them choose: a new major, or the additive alternative below. The gate only
  demands a minor for these; the major is their decision, and you raise it.
- **A breaking change is the user's decision, not yours.** Show them the
  list and the consumers it affects, and offer the additive alternative
  first: add the new thing beside the old and mark the old `deprecated: true`.
  If they choose to break, copy the major's file to the next one
  (`openapi.v2.yaml`: version `2.0.0`, paths `/v2`, ids `_v2`; `docs/spec.md`).
- Change the features with the contract: update the scenarios the change
  affects, add scenarios for new behaviour, and delete scenarios only for
  behaviour the user has agreed to remove. Word new sentences like the
  existing ones - read `steps/` to see which sentences already have a step.
- A scenario about several things happening at once is needed only where
  the user has said what must still hold.
- Regenerate and commit `http/contract.http` and the README
  (`task http:generate`, `task readme:generate`), and re-read the README's
  Notes with the user: a change can make them untrue.
- After the spec changes, the implementation is behind: `task ci` fails
  until `/implement-api` catches it up.
