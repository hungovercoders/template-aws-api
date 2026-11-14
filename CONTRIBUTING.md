# Contributing

Every change to this API takes the same route as its first build: **the spec
changes first, then the implementation catches up, and the gates say when it
is done.** That holds for a new feature, a changed rule, a bug fix and a
removal alike. Nothing is changed in the code alone.

## Changing what the API does

1. **Change the spec** - `/write-spec`, or by hand. Update the feature files
   and the contract together, in `specs/`. `task spec:compat` says whether
   the change breaks consumers and holds `info.version` to it; a breaking
   change is a decision, not an accident. See [the spec guide](docs/spec.md).
2. **Catch the implementation up** - `/implement-api`. `task ci` is now red,
   and says exactly where: scenarios that fail, operations that are still
   stubs, steps that are missing or no longer used. See
   [testing](docs/testing.md).
3. **Ship it** when `task ci` is green. See [deploying](docs/deploying.md).

| You want to | The route |
| --- | --- |
| Add an operation or a behaviour | Add scenarios and the contract for it; `task scaffold` writes the stubs; implement them |
| Change a rule | Change the scenarios that state it, and the contract if its shape changes. If consumers can observe the difference it is breaking - a new major version - even when the contract's shape is the same; fix what goes red |
| Fix a bug | A bug is a scenario that is missing or wrong. Write the scenario that fails first, then fix the code |
| Remove something | Delete its scenarios and its part of the contract (breaking: a new major version); delete the code and steps the gates then call unused |
| Rename or reshape data | Change the contract; the generated types make the compiler find every use |
| Update a dependency | Renovate proposes it; `task ci` decides |

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
2. **Make it on `main`**, with `task skeleton:lock` in the same commit.
   `ci` is red there by design (there is no spec to implement), so the check
   that matters is `template`: every gate, with the example laid over your
   change.
3. **Merge it down** `main` → `example/spec` → `example/implementation`, and
   confirm `example/implementation` is green.

| Branch | Is | CI |
| --- | --- | --- |
| `main` | The template | `ci` red by design; `template` green |
| `example/spec` | `main` plus the example spec | Red by design |
| `example/implementation` | `example/spec` plus its implementation | Green |

- **Never change a skeleton file on an example branch.** The example branches
  follow the route above themselves: a change to the example goes into
  `example/spec` first, then `example/implementation`.
- **The branches differ only in what an API owns:** `example/spec` adds
  `specs/`, `http/contract.http` and its README; `example/implementation`
  adds `src/operations/`, `src/domain/`, `src/store/`, `steps/` (but
  `world.ts`) and their tests.
- **When the starter `specs/openapi.yaml` changes on `main`,** the example
  branches keep their own contract: restore it from before the merge and
  re-apply the idea by hand. Never resolve with `-X ours` or `-X theirs`.
- **When `README.md` changes on `main`,** the merge conflicts, because the
  example branches' READMEs are generated from their contract. Keep theirs
  (`git checkout --ours README.md`).
- **Never rewrite what is pushed.** `main` and `example/*` are protected
  (`.github/rulesets/protect-demo-branches.json`); only add commits or merges.
- `renovate.json` keeps npm, GitHub Actions, Terraform, mise and the
  emulator and Prism pins moving; install the Renovate app to switch it on.
<!-- template-only:end -->
