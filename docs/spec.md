# The spec

> **For** whoever writes or changes the contract and feature files. **When** before and during the spec phase, and whenever the API has to change.

## Writing and changing the spec

**Writing it.** The `write-spec` skill (`.claude/skills/write-spec`) helps
you get from requirements to a spec. You own the requirements: it asks what
the API is for, who uses it and what the rules are, proposes the conventional
parts, and writes only what you have confirmed. It writes the features first,
then a contract that carries exactly that behaviour, runs the spec gates, and
has you try the result on the mock before you approve it. It stops there;
`/implement-api` builds it.

**Changing it.** A published contract has consumers, so every change is
versioned. `info.version` is a semantic version, and `task spec:compat` - a
gate in `task ci` - holds it to what actually changed:

| The change | Examples | `info.version` needs |
| --- | --- | --- |
| Breaking - an existing consumer can fail | Removing or renaming an operation, property or enum value; a new required request property; a tighter limit | A new **major** (a new minor while the API is `0.x`) |
| Additive - existing consumers are unaffected | A new operation, a new optional request property, a new response property | A new **minor** |
| Clarifying - the API behaves the same | Descriptions, examples | A new **patch** |

The gate compares the spec with the last published one: on a branch, the
default branch; on the default branch, the previous commit. It prints every
contract change, grouped by whether it breaks consumers (using
[oasdiff](https://github.com/oasdiff/oasdiff)), and fails if the version does
not match. So a breaking contract change cannot be merged by accident.

A rule can also change while the contract's shape stays the same - the same
field, a different answer - and no contract diff can see that. So the gate
also lists every existing scenario that was changed or removed, as "Existing
behaviour changed". It demands at least a new minor for those and says
plainly that, if consumers can observe the difference, the change is breaking
and needs a new major. That call is a person's; the gate makes sure it is
made in the open.

```sh
task spec:compat                         # against the default branch / previous commit
SPEC_BASELINE=v1.4.0 task spec:compat    # against any tag, branch or commit
```

Prefer not to break: add the new thing beside the old, mark the old
`deprecated: true`, and remove it in a later major version. The gate checks
the contract's version; how you serve two major versions side by side, if
you need to, is a deployment decision the template leaves to you.

### Running two major versions

A breaking change needs a new major version, but consumers of the old one do
not move the same day. Every response carries an `api-version` header with
the contract version that produced it, and the request log records it, so
you can always tell which is being served and who is still calling the old
one.

To run both until consumers have moved, deploy each major as its own stack
from its own branch - the template already supports any number of stacks:

1. Before merging the breaking change, branch the current contract and
   implementation: `git branch release/v1`.
2. `main` moves to `2.0.0` and deploys as before, under a new stack name:
   `task deploy NAME=my-api-v2`.
3. `release/v1` keeps serving the old contract: `task deploy NAME=my-api-v1`
   from that branch. It accepts fixes; `spec:compat` there still refuses
   breaking changes.
4. When the logs show no more `api_version` 1 traffic, `task destroy
   NAME=my-api-v1` and delete the branch.

Each stack has its own URL, table and alarms. Putting them behind one domain
(`/v1`, `/v2`) and moving data between tables are decisions for your API;
the template does not make them for you. The CI deploy job deploys `main`
only, so the older major is deployed by hand or by a copy of that job.

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
[Spectral rule](https://docs.stoplight.io/docs/spectral/d3482ff0ccae9-rules).
It may make an inherited rule stricter, never weaker: the lint tasks refuse a
ruleset that drops the house rules, switches or softens one they hold, or
exempts paths with `overrides` (`scripts/rulesets.ts`).

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

<!-- component:asyncapi:start -->
## Messages and events: the AsyncAPI contract

An API that takes work from a queue, or publishes what happened, has a second
contract: `specs/asyncapi.yaml`, an [AsyncAPI](https://www.asyncapi.com) 3.1
document. A `receive` operation is a message the API accepts; a `send`
operation is an event it publishes. An API with neither has no such file, and
every task below then has nothing to do.

It is held to the same standards as the OpenAPI contract, with AsyncAPI's own
tools (`tools/asyncapi/`):

| Task | What it holds |
| --- | --- |
| `task asyncapi:check` | The document is valid, and every operation has a scenario tagged `@operation:<name>` - the same tag as for HTTP, so a name is unique across both contracts |
| `task asyncapi:lint` | The house rules in `rules/asyncapi.yaml` (lower snake_case names, a summary, a payload schema); this API's own go in `.spectral.asyncapi.yaml`, which extends it |
| `task asyncapi:compat` | What changed since the last published contract, and that its own `info.version` says so. It is versioned apart from the OpenAPI contract: a breaking event does not make a new major version of the HTTP API |
| `task asyncapi:examples:check` | `messages/<message>.json`, an example of every message, matches the contract; `task asyncapi:examples` writes them. They are what a sender or consumer builds against before the API exists |

`task generate` also writes `src/generated/messages.d.ts` (a type for every
payload, by Modelina) and `src/generated/async-operations.ts`.

**Every message is a CloudEvent** 1.0 in structured JSON mode. The envelope
is the skeleton's (`tools/asyncapi/cloudevent.yaml`); a message extends it
and adds only what is its own, the `type` it fixes and the shape of `data`:

```yaml
payload:
  allOf:
    - $ref: '../tools/asyncapi/cloudevent.yaml#/CloudEvent'
    - type: object
      required: [data]
      properties:
        type: { type: string, const: com.example.beer_catalogue.beer.created.v1 }
        data: { type: object, required: [beer_id], properties: { beer_id: { type: string } } }
```

A `type` is `com.<org>.<api>.<thing>.<happened>.v<major>`: lower case, what
happened in the past tense, the major version last. `asyncapi:check` holds
every message to the envelope and to a `type` of its own; `asyncapi:lint`
holds the `type` to that form and the message to
`contentType: application/cloudevents+json`. At runtime
`src/lib/cloudevents.ts` sets `id`, `source`, `time` and the trace on what is
published, and refuses what is received unless it is a CloudEvent the
contract says the API accepts. A change to the envelope itself counts as a
breaking change to the contract.

**Changing an event that is already published.** A change consumers would
notice is a new `type`, ending `.v2`, published alongside `.v1` for as long
as they need. Adding a message is not breaking; removing `.v1` later is, and
takes a new major version of the contract.

**What counts as breaking.** AsyncAPI's diff compares the two documents path
by path, so it cannot tell a message the API sends from one it receives. The
rules are the cautious ones for both: a property removed, retyped or made
required is breaking, as is a constraint added to a schema already published,
a removed operation or message, a changed channel address, and deleting the
contract while it still has operations; a property or message added, and
words reworded, are not.
A change the rules cannot place is listed and treated as breaking until a
person has looked. So the gate never passes a breaking change, and now and
then asks for a major version where a minor one would have done.
<!-- component:asyncapi:end -->
<!-- component:publish:start -->
**What a subscriber is promised.** An event is published if and only if the
change it describes was made: both are one write. It is delivered **at least
once**, and events about one thing **may arrive out of order** - so a
subscriber tells a repeat by the event's `id` and orders by its `time`. Say
so in the contract's `info.description`.

**How a subscriber reads one.** The bus is EventBridge, which carries the
CloudEvent inside its own envelope: the event is the envelope's `detail`,
and the envelope's `source` and `detail-type` repeat the CloudEvent's
`source` and `type` so a rule can match on them. The envelope has an `id`
of its own; the one to tell a repeat by is `detail.id`. A subscriber that
wants the CloudEvent alone gives its rule's target `input_path = "$.detail"`.
<!-- component:publish:end -->
<!-- component:data:start -->
**The events as data.** Kept in S3, the events have a third contract,
`specs/datacontract.yaml`: see [Events as data](data.md).
<!-- component:data:end -->

## Try the contract before it is built

In the spec phase there is nothing to run yet, but a contract is easier to
judge by calling it than by reading it. `task mock` starts
[Prism](https://github.com/stoplightio/prism), which serves
`specs/openapi.yaml` as a mock API:

```sh
task mock                       # http://127.0.0.1:4010, answers from the contract's examples
task mock -- --dynamic          # generate varied data from the schemas instead
MOCK_PORT=4011 task mock

curl http://127.0.0.1:4010/things
curl -X POST http://127.0.0.1:4010/things -H 'content-type: application/json' -d '{}'
curl http://127.0.0.1:4010/things/123 -H 'Prefer: code=404'   # ask for a documented response
```

It validates each request against the contract and answers with a documented
response, so a consumer can build against it while the API is being
implemented. It is a mock: it holds no data and knows none of the behaviour
in the feature files - something you create is not there when you list. Good
examples in the contract make it far more useful.

Prism is not a gate and is not installed with the project; the task fetches
the version pinned in `Taskfile.yml` the first time you run it.

## Conventions the template assumes

- Request and response bodies are JSON.
- Errors are RFC 9457 `application/problem+json` (`Problem` in the contract).
- One DynamoDB table with string keys `pk` and `sk`, and two generic indexes
  (`gsi1`, `gsi2`, keyed on `gsi1pk`/`gsi1sk` and `gsi2pk`/`gsi2sk`) for
  listings and lookups the keys cannot serve. Defined once in `infra/main.tf`
  and created from it for local runs too.
