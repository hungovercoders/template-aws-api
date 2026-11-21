# Changing a spec

Part of the `write-spec` skill: read it when the contract already has operations - every change to a published spec.

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
