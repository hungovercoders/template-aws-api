# When the spec has changed

Part of the `implement-api` skill: read it for every change after the first build.

The same workflow serves every change after the first build. Behaviour never
changes in the code alone - if a change has no scenario, stop: it needs the
spec changed first (`write-spec`).

**Start by reading what changed:** `git diff <the commit the code was last
green at> -- specs`. A rule that changed while the contract kept its shape,
or a new row in a scenario outline, shows only when `task features` runs. A
new major (`openapi.v2.yaml`) is new operations, `_v2`, over the same store.

- **Something new** - `task scaffold` adds a stub for each new operation and
  a pending step for each new sentence, and touches nothing you have written.
  Implement them as in workflow steps 5 and 6 (`SKILL.md`), in your existing step files; extend an
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
