# template-aws-api

BDD and contract driven AWS Lambda API. `specs/` (OpenAPI contract + feature
files) is the requirement; `task ci` is the definition of done.

- The skeleton (router, validation, harness, gates, CI, infra) is the same for
  every API and is already built. Do not rebuild or restructure it; write only
  the business logic the specs describe: `steps/`, `src/operations/`,
  `src/domain/`, `src/store/` and their tests.
<!-- component:consume:start -->
- A message the API receives is a `receive` operation in `specs/asyncapi.v<N>.yaml`
  and one function in `src/consumers/`; the queue and retries are the skeleton's.
<!-- component:consume:end -->
<!-- component:publish:start -->
- An event the API publishes is a `send` operation there: write `outbox(event)`
  in the transaction that makes the change; never call the event bus yourself.
<!-- component:publish:end -->
- `task skeleton:check` fails if a skeleton file differs from `skeleton.lock`.
  Undo the change; do not run `task skeleton:lock` or edit the lock unless the
  user has asked for a skeleton change.
- Generate before you write: anything a command can derive from the specs
  (types, the route table, operation and step outlines, `.http` requests) is
  produced by `task generate`, `task scaffold` or `task http:generate`, never
  written by hand. Use judgement only where no deterministic tool exists.
- Tools come from `mise.toml`; every command is a task - run `task` to list them.
- Every change to what the API does goes spec first, then implementation -
  a new feature, a changed rule, a bug fix (a bug is a missing or wrong
  scenario) and a removal alike. Never change behaviour in the code alone.
  `CONTRIBUTING.md` has the route for each kind of change.
- To write or change the spec with the user, follow `write-spec` (and `write-nfrs`
  for its NFRs). The user owns the requirements: ask, propose, confirm; never invent.
- To implement or change the API from the specs, follow the `implement-api` skill.
- A skill is the instructions in `.claude/skills/<name>/SKILL.md`. If your
  tool does not load skills itself, read that file and follow it.
- `skills.json` lists every skill in `.claude/skills/` and those the template
  offers. Never edit a copied skill or add an unlisted one (`task
  skills:check`). Before working with a service or tool that has no skill
  here, ask the user whether to add one (`task skills:add`); never unasked.
- Use the `aws-emulator` skill before deciding AWS Emulator cannot do
  something, when a call to it fails to connect or sign, and when a new AWS
  service enters `infra/`. Where a copied skill and this repository disagree,
  the repository wins: the emulator version is pinned (`EMULATOR_VERSION`),
  so never upgrade it except through the pull request that moves the pin.
  Run the local stack with `EMULATOR_TELEMETRY=off`.
- `components.json` declares the template's optional components;
  `task component:list` says which this repository has. Never build a
  removed one by hand, and never remove or restore one unasked: with the
  user's agreement, `task component:remove -- <name>` or
  `task component:add -- <name>`, which brings it back from the template.
- `specs/` is read-only unless the user asks for a spec change. The tags and budget
  in `infra/{tags,budget}.auto.tfvars.json` are the owner's to say: ask, never guess.
- A contract is a file per live major (`specs/openapi.v<N>.yaml`, paths `/v<N>`,
  names `_v<N>`); `task spec:compat` holds each to its version. A breaking
  change is a new major beside the old, and the user's decision.
- Never weaken a gate (Taskfile, cucumber config, the spec and backlog
  checks, the contract lint rules, CI) to get green.
- Contract standards are lower snake_case (`rules/house.yaml`); rules for one
  API go in `.spectral.yaml`.
- `src/generated/` is generated; never edit or commit it. What is generated
  and committed (`http/contract.http`, the README's API section, whatever a
  gate calls out of date) is made again with the task that gate names. With
  a spec, the repository describes the API, not the template.

<!-- template-only:start - removed by `task adopt` when a repository becomes an API -->
## Changing the template itself

This repository is the template. Before changing the skeleton or the
examples, read "Changing the template itself" in `CONTRIBUTING.md` and
follow it. The rules that prevent damage, so they are always in view:

- Skeleton changes go on `main`, with `task skeleton:lock` in the same commit.
  The worked example is on `main` too, as what each step adds
  (`examples/<name>/{spec,implementation}`): change it in the same pull
  request, through `task example` and `task example:save`, never by hand.
- Never rebase, amend, reset or force-push `main`.
- Write a document only when no gate, generator or task description can
  carry it; give it one reader and one home. Do not raise a `task docs:check`
  budget to fit new text - cut, or ask the user.
<!-- template-only:end -->
