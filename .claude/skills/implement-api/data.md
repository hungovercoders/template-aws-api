# When the events are kept as data

Read this when `specs/datacontract.v<N>.yaml` exists. It adds to the workflow in
`SKILL.md` and to [events.md](events.md); nothing there changes.

The skeleton already keeps every published event in S3 and tests what
landed against the data contract (`docs/data.md`). There is nothing to
implement for it: no code of yours writes to the bucket, and none should.

## What changes for you

- `task acceptance` has one more gate, `data:test`, after the features and
  before the fuzz run: every event the scenarios published must have landed
  in S3, and the data must keep the contract - types, required properties,
  limits and quality rules.
- The data contract is part of `specs/`: read-only, like the rest. Never run
  `task data:generate` or edit `specs/datacontract.v<N>.yaml` to make a gate
  pass. `data:lint`, `data:check` or `data:compat` failing is a fault in the
  spec: report it, as for `spec:check`.

## When `data:test` fails

- **An event never landed.** It was published - `publish:check` passed - and
  did not reach the bucket. That is the skeleton's or the local stack's, not
  your code: report it with the output.
- **An event landed that the data contract does not describe**, or **no
  event of a kind landed**, so part of the contract went untested. The two
  contracts, or the scenarios, disagree: a fault in the spec. Report it.
- **An event is not in the Parquet, or is there twice.** The compactor is the
  skeleton's: report it with the output, as for an event that never landed.
- **The data breaks the contract.** The event your code published is valid
  against the AsyncAPI contract and still breaks a rule the data contract
  adds - a quality rule, usually. Fix the code if it publishes a value the
  rule forbids. If the rule cannot hold for a valid event, the two contracts
  disagree: stop and tell the user, quoting the rule and the event.

`task data:query -- "select * from <event>_raw"` shows what landed, against
`task dev` (`<event>` once `task data:compact` has run): use it to see the
value a rule objected to.
