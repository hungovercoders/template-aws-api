# Testing

> **For** whoever is implementing an API or reading a failed CI run. **When** a gate fails, or you want to run or poke at the API locally.

## The gates

Each gate fails for one reason and says what it is:

- **`skeleton:check`** - a skeleton file differs from `skeleton.lock`. The
  skeleton is the same for every API, so implementing a spec should never
  change it; see [Changing the skeleton](../CONTRIBUTING.md#what-you-do-not-change).
  A component removed with `task component:remove` is expected to be
  missing; one of its files coming back by hand is not.
- **`docs:check`** - `AGENTS.md`, a skill, the README or a guide is over its
  line budget, a guide does not say who it is for, or a link is broken; see
  [What gets documented](../CONTRIBUTING.md#what-gets-documented).
- **`skills:check`** - a skill in `.claude/skills/` is not listed in
  `skills.json`, a listed one is missing, a copied one was edited, or its
  source has moved to a newer commit than the copy; run `task skills:fetch`
  and commit.
- **`spec:check`** - no operations, an operation without an `operationId`, an
  operation no scenario is tagged for, or a tag naming an operation that does
  not exist.
- **`spec:lint`** - the contract breaks a rule in `rules/house.yaml` or
  `.spectral.yaml`. Warnings fail as well as errors.
- **`spec:compat`** - the contract changed since the last published one and
  `info.version` does not say so: a breaking change without a new major
  version, an API change without a new minor, or an edit without a new version.
<!-- component:asyncapi:start -->
- **`asyncapi:check`**, **`asyncapi:lint`**, **`asyncapi:compat`**,
  **`asyncapi:examples:check`** - the same four failures for
  `specs/asyncapi.yaml` as `spec:check`, `spec:lint`, `spec:compat` and
  `http:check` have for the OpenAPI contract; see
  [Messages and events](spec.md#messages-and-events-the-asyncapi-contract).
  Without that file they have nothing to do.
<!-- component:asyncapi:end -->
- **`http:check`** - `http/contract.http` no longer matches the contract; run
  `task http:generate` and commit it.
- **`readme:check`** - the contract describes an API but `README.md` still
  describes the template, or its API section is out of date; run
  `task readme:generate` and commit it.
- **`test:unit`** (`test/routes.test.ts`) - an operation in the contract with
  no file in `src/operations/`, or one that is still the stub `task scaffold`
  wrote.
- **`features`** - an undefined step, a failed assertion, or *any* response
  whose status, content type or body is not what the contract documents for
  that operation.
- **`responses:check`** - a response the contract documents that no scenario
  was answered with, so the contract promises an outcome the behaviour spec
  never shows. Add the scenario, or remove the response. Runs in `acceptance`,
  after the features. Not required: 5XX, `default`, and a 400 on an operation
  that takes no input.
- **`tags:check`** - a resource in `infra/` that can carry the stack's tags
  would be created without them. Runs in `ci`, after `infra:validate`.
<!-- component:consume:start -->
- **`consume:check`** - a `receive` operation of the AsyncAPI contract that
  no scenario delivered a message to, so the contract says the API accepts
  something the behaviour spec never shows. Runs in `acceptance`, after the
  features. `test:unit` (`test/consumers.test.ts`) fails for a `receive`
  operation with no file in `src/consumers/`, or one that is still a stub.
<!-- component:consume:end -->
<!-- component:publish:start -->
- **`publish:check`** - an event of the AsyncAPI contract (a `send`
  operation) that no scenario saw published. Every event published while
  the scenarios run is also held to the contract, looked at or not. Runs in
  `acceptance`, after the features.
<!-- component:publish:end -->
<!-- component:data:start -->
- **`data:lint`, `data:check`, `data:compat`** - the data contract is not
  valid ODCS or breaks a house rule; disagrees with the AsyncAPI contract or
  leaves out what the infrastructure reads; or changed without its version
  saying so. **`data:test`**, in `acceptance` after the features - an event
  the scenarios published never landed in S3, or the data that landed
  breaks the contract. See [Events as data](data.md#gates).
<!-- component:data:end -->
- **`check`** - not a gate of its own: the fast gates above for the stage in
  `.stage`, which the pre-push hook runs (`task hooks:install`). `template`
  checks the skeleton and docs; `spec` adds the spec gates; `implemented`
  adds the unit tests, typecheck and `steps:check`. `task stage -- <stage>`
  moves on once that stage's gates pass. `task ci` ignores the stage.
- **`steps:check`** - a step definition that no sentence in the feature
  files uses any more. Delete it: the behaviour it described has left the spec.
- **`contract:fuzz`** - a generated request that produced a 5xx, an
  undocumented status, or a body that does not match its schema. The seed is
  fixed, so a failure reproduces.

The router validates every incoming request against the contract before your
code runs, so the 400 responses are the contract's, not hand-written checks.

## Exploring the API by hand

For poking at the API - as opposed to testing it - the template uses plain
`.http` files and [httpYac](https://httpyac.github.io) to send them. A
`.http` file is just the request as text, so it diffs, reviews and lives in
the repository like any other source, and the same file works from the
command line, in VS Code (the httpYac extension) and in JetBrains IDEs (the
built-in HTTP client).

You do not have to write any to start: `http/contract.http` is generated from
the contract, with one ready-to-send request per operation, filled in from
the contract's examples.

```sh
task http                      # pick a request and send it to the local stack (run `task dev` first)
ENV=mock task http             # ...to the mock instead (run `task mock` first) - works in the spec phase
ENV=aws task http              # ...to a deployed stack
task http -- --name create_thing     # one request, by operationId
task http -- --all                   # every request in turn
```

| Environment | Sends to | Caller |
| --- | --- | --- |
| `mock` | Prism, `http://127.0.0.1:4010` | any token |
| `local` | the running `task dev`: its URL on AWS Emulator, from `.local/stack.json` | a token `task dev` minted, as the caller `explorer` |
| `aws` | your deployed API | a real token |

Environments are in `http/http-client.env.json`. For `aws`, put your stack's
`base_url` and a `token` in `http/http-client.private.env.json`, which is
never committed:

```json
{ "aws": { "base_url": "https://abc123.execute-api.eu-west-2.amazonaws.com", "token": "eyJ..." } }
```

`http/contract.http` is committed, so the requests can be read on GitHub and
run straight after cloning. When the contract changes, run
`task http:generate` and commit the result; `task ci` fails (`http:check`)
if the two have drifted. Keep requests of your own - a sequence that reproduces a bug, a
demo - in other files in `http/`; `task http` offers those too. These files
are for exploring. What the API must do belongs in a feature file, where it
is checked on every run.

## AWS Emulator

Local runs and CI use [AWS Emulator](https://docs.aws.amazon.com/emulator/latest/userguide/what-is-service.html)
for the whole stack, not only its table. `local/stack.mjs` starts it, points the AWS SDK at it using the
credentials and certificate it writes to `~/.aws/emulator/<port>/`, runs the
task, and stops it. Emulated resources live in memory only.

- **Linux (and CI):** `task emulator:install` runs automatically. It downloads
  the pinned package, verifies AWS's signature and unpacks it into `.tools/` -
  nothing is installed system-wide.
- **Version:** pinned as `EMULATOR_VERSION` in `Taskfile.yml`, so every run
  tests against the same emulator and a release that changes a result
  arrives as a pull request, not a surprise. AWS publishes security fixes
  only in the latest release, so Renovate proposes each new version and it
  merges itself once the required checks pass. AWS's `aws-emulator` skill
  says never to pin; here the pin wins. Published versions are listed in
  [versions.json](https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/versions.json).
- **When it will not start, connect or sign:** the `aws-emulator` skill
  (`.claude/skills/aws-emulator`) has the troubleshooting, and checks whether
  an AWS operation is expected to work on the emulator.
- **macOS / Windows:** AWS ships no native package; run `task emulator:docker`
  in one terminal and the other tasks in a second. A running emulator is
  picked up automatically.
- **Port:** `EMULATOR_PORT` (default 9297).
- **Telemetry:** the emulator reports anonymous usage data to AWS by default.
  The local stack turns it off in CI and leaves it alone elsewhere; set
  `EMULATOR_TELEMETRY=off` to turn it off ([details](https://docs.aws.amazon.com/emulator/latest/userguide/telemetry.html)).

### How close to production the tests are

Every run of `features`, `contract:fuzz` or `acceptance` builds this stack
from scratch and throws it away:

| Layer | In the tests | Same as production? |
| --- | --- | --- |
| Lambda code | `dist/handler.mjs`, the esbuild bundle Terraform packages | Yes - the same file |
| Infrastructure | `infra/` applied to AWS Emulator with `terraform apply` | Same definitions; the emulator's control plane, not AWS's |
| DynamoDB | The table that apply created, on AWS Emulator | Emulated |
| API Gateway | The emulator's HTTP API: the routes apply created, each integrated with the function | Emulated |
| Lambda runtime | The emulator runs the bundle as the function, on its Node 22 runtime | Emulated |
| Authorizer | The emulator's JWT authorizer refuses a missing or malformed token and a wrong issuer or audience, and passes the claims to the function. It does not verify signatures | Partly |
<!-- component:consume:start -->
| Queue | The SQS queue and dead-letter queue that apply created; the emulator hands each batch to the consumer function, offers a failed message again and dead-letters it after its tries | Emulated. Locally a message gets two tries five seconds apart, not three at a minute |
<!-- component:consume:end -->
<!-- component:publish:start -->
| Events | The table's stream, the forwarder function, the event bus and the rule that logs every event, as apply created them; scenarios read the log | Emulated. The scenarios only take the path where every event is published. That the stream starts a batch again from an event that failed, as it does on AWS, is not tested there |
<!-- component:publish:end -->
<!-- component:data:start -->
| Data | The rule, the Firehose stream and the bucket apply created; `data:test` reads what Firehose wrote | Emulated. The bucket is made through Cloud Control because the emulator has no S3 Control; Firehose emits no metrics there, so its two alarms never change state |
<!-- component:data:end -->
| Tags | Every resource carries the stack's tags, and the emulator reports them: by resource, and through the tagging API | Emulated. The resource group is created, but lists only itself as a member there |
| IAM | Not enforced the way AWS enforces it; the emulator's guide says not to test security on it | No |

Nothing stands in for AWS: every request in a scenario or a fuzz run goes
through the emulator's API Gateway to the function and on to its DynamoDB.
What only a real deploy proves is token signatures, IAM and anything the
emulator gets wrong. The emulator's Node runtime is not the whole of Node -
`node:http`, `node:https` and `node:module` are missing in 1.0.365 - so a
dependency that needs them fails there as a `Runtime.ImportModuleError`.

A request takes tens of milliseconds, so the scenarios and the fuzz run take
tens of seconds each. Bringing the stack up takes longer than either: about
two minutes with every component present. Each queue takes 25 seconds and
the data bucket about a minute, in parallel; without them, half a minute. When a run fails, `local/stack.mjs` prints the
function's log if the AWS CLI is installed.

A new emulator release can change a response to match AWS more closely, which
is why the version is pinned; see
[how fidelity changes affect your tests](https://docs.aws.amazon.com/emulator/latest/userguide/versioning.html).
