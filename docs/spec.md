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

The gate compares the contract with the last published one using
[oasdiff](https://github.com/oasdiff/oasdiff): on a branch, the contract on
the default branch; on the default branch, the previous commit. It prints
every change, grouped by whether it breaks consumers, and fails if the
version does not match. So a breaking change cannot be merged by accident: it
is listed in the CI log and needs a deliberate major version.

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
[Spectral rule](https://docs.stoplight.io/docs/spectral/d3482ff0ccae9-rules):

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
