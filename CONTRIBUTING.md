# Contributing

Every change to this API takes the same route as its first build: **the spec
changes first, then the implementation catches up, and the gates say when it
is done.** That holds for a new feature, a changed rule, a bug fix and a
removal alike. Nothing is changed in the code alone.

## Changing what the API does

1. **Change the spec** - `/write-spec`, or by hand. Update the feature files
   and the contract together, in `specs/`. `task spec:compat` says whether
   the change breaks consumers and holds each major's `info.version` to it; a
   breaking change is a new major's file beside the old - a decision, not an
   accident. See [the spec guide](docs/spec.md#majors-side-by-side).
2. **Catch the implementation up** - `/implement-api`. `task ci` is now red,
   and says exactly where: scenarios that fail, operations that are still
   stubs, steps that are missing or no longer used. See
   [testing](docs/testing.md).
3. **Ship it** when `task ci` is green. See [deploying](docs/deploying.md).

| You want to | The route |
| --- | --- |
| Add an operation or a behaviour | Add scenarios and the contract for it; `task scaffold` writes the stubs; implement them |
| Change a rule | Change the scenarios that state it, and the contract if its shape changes. If consumers can observe the difference it is breaking - a new major, `specs/openapi.v<N+1>.yaml` beside the old - even when the contract's shape is the same; fix what goes red |
| Fix a bug | A bug is a scenario that is missing or wrong. Write the scenario that fails first, then fix the code |
| Remove something | Leave it out of the next major's file (breaking), mark it `deprecated: true` in the old one, and delete the old major's file once it is not called; delete the code and steps the gates then call unused |
| Rename or reshape data | Change the contract; the generated types make the compiler find every use |
<!-- component:consume:start -->
| Take a new kind of message | Add its scenarios and a `receive` operation to `specs/asyncapi.v<N>.yaml`; `task scaffold` writes the stub in `src/consumers/`; implement it |
| Stop taking a message | Leave its `receive` operation out of the next major's AsyncAPI file (breaking for whoever sends it), publish the old file with `info.x-deprecated: true`, then delete it with its scenarios; delete its file in `src/consumers/` and the steps `steps:check` then calls unused |
<!-- component:consume:end -->
<!-- component:publish:start -->
| Publish a new event, or publish one in a new case | Add its scenarios and a `send` operation to `specs/asyncapi.v<N>.yaml`; `task generate` writes its function; write `outbox(event)` in the transaction of the change |
| Change an event that is already published | A change subscribers would notice is a new event: add it with a type ending `.v2`, named `_v2`, and publish both for as long as they need. Remove `.v1` later, as below |
| Stop publishing an event | Leave its `send` operation out of the next major's AsyncAPI file, then retire the old file as above; `task typecheck` then finds every place it was written |
<!-- component:publish:end -->
<!-- component:data:start -->
| Change an event that is kept as data, or what is promised of the data | The event first, as above; `task data:generate` carries what was added or changed into `specs/datacontract.v<N>.yaml`, and names what is no longer published for you to remove - breaking for whoever reads the data: the next major's file, whose data lands beside the old. Owner, classification, retention and freshness change there, with a new version (`docs/data.md`) |
<!-- component:data:end -->
| Use a capability the API removed | `task component:add -- <name>` restores it from the template, with what it needs; then the spec first, as for any change |
| Change who owns the API | `domain` and `team` in `infra/tags.auto.tfvars.json`; the next deploy re-tags the stack, and `task aws:bootstrap` the deploy role and state bucket. The data contract names its own `team` |
| Update a dependency | Renovate proposes it; `task ci` decides. When it moves a skill source in `skills.json`, run `task skills:fetch` on its branch and push |
| Work with a service the API integrates with | Ask whether a skill for it should be added; with the owner's agreement, `task skills:add`. A skill every API needs is a change to the template instead |

Do not start from the code. A change made there first has no scenario that
proves it and no contract that documents it, and the next person - or agent -
has nothing to check it against.

## What you do not change

The skeleton - the router, the local stack, the gates, CI and the Terraform -
is the same for every API built on the template, and `task skeleton:check`
fails if it changes. If the API needs something the skeleton lacks, that is a
change to the skeleton, made deliberately:

```sh
task skeleton:lock      # accept the skeleton as it is now, then commit skeleton.lock
```

The changed lock shows in the diff, so a reviewer sees that the skeleton
moved and asks why. Version pins (`*_VERSION` in `Taskfile.yml`, action
versions in the workflow) are ignored, so dependency updates do not trip it.
If the change would help every API, make it in the template instead.

## What gets documented

Context is hard to manage, so a document exists only where it is necessary:

1. **Prefer something executable.** A gate, a generator, a task's
   description or an alarm's description says it once and cannot go stale.
   Write prose only for what none of those can carry.
2. **Every document names its reader and their moment.** Each guide opens
   with who it is for and when. If you cannot fill that in, do not write it.
3. **One home per fact.** State it once and link to it.

`task docs:check` holds this in place: line budgets (at the top of
`scripts/docs-check.ts`), a reader line on every guide, and links that
resolve. Raising a budget is a decision: first ask what could be cut, or
turned into a gate. The README's API section is generated from the contract;
only its Notes are written by hand.

<!-- template-only:start - removed by `task adopt` when a repository becomes an API -->
## Changing the template itself

This repository is the template, so it has one more kind of change: to the
skeleton every API shares.

1. **Open an issue** saying what is missing and what "done" looks like. A
   change that would help only one API belongs in that API.
2. **Make it on `main`**, with `task skeleton:lock` in the same commit, and
   `task changelog:generate` once the branch is up to date with `main`.
   `ci` is red there by design (there is no spec to implement), so the check
   that matters is `template`: it makes every step of every example over
   your change and runs that step's gates there.
3. **Change the example in the same pull request** when your change needs it
   to move - a generator's new output, a new required file. Make the step,
   change it there and save it back:
   `task example -- beer-catalogue spec`, work in
   `.local/examples/beer-catalogue-spec`, then
   `task example:save -- beer-catalogue spec`; the same for `implementation`.

The example is kept on `main` as what each step adds, never as branches:

| `examples/beer-catalogue/` | Holds | Made, `task ci` is |
| --- | --- | --- |
| `spec/` | All of `specs/`, and what an API owns beside it: `README.md`, `.stage`, `http/`, `messages/`, its tags and budget | Red by design; `task check` green |
| `implementation/` | What implementing it adds: `src/operations/`, `src/domain/`, `src/store/`, `src/consumers/`, `steps/` and their tests | Green |

- **No step holds a skeleton file** (`task example:check`, in `task check`),
  so an example always has the template as it is: there is nowhere to
  change the skeleton but `main`. `example:save` refuses to save one.
- **A made step is a repository of its own**, committed twice: as last
  published on the default branch, then as it is in your tree. So
  `spec:compat` and the other compat gates hold the example's contracts to
  their versions as they would any API's.
- **`task adopt` deletes `examples/`**, so an API made from the template
  starts from the template alone.
- **An optional part of the skeleton is a component:** declared in
  `components.json`, its sections of shared files marked, so an API can
  remove it and restore it. `test/components.test.ts` proves the mechanism.
- **Never rewrite what is pushed.** `main` is protected
  (`.github/rulesets/protect-demo-branches.json`); only add commits or merges.
- `renovate.json` keeps npm, GitHub Actions, Terraform, mise, the emulator,
  Prism and schemathesis pins and the skill sources moving; install the
  Renovate app to switch it on. An emulator update merges
  itself once `template` passes, which needs auto-merge allowed on the
  repository and `skeleton delivers the example` required on `main`.
<!-- template-only:end -->
