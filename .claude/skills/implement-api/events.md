# Implementing events the API publishes

Read this when `specs/contracts/asyncapi.v<N>.yaml` has a `send` operation. It adds to the
workflow in `SKILL.md`; nothing there changes.

The skeleton already carries an event from the table to the event bus: it
reads what the operation wrote, puts it on the bus as the CloudEvent the
contract describes, tries again while the bus is failing, and sets aside an
event the bus will never take. Do not build any of that, and never call
EventBridge from an operation. You write one thing: the event, in the same
transaction as the change it is about.

## Workflow

1. `task asyncapi:check` and `task asyncapi:lint` must pass first. A failure
   is in the spec: report it, as for `spec:check`.
2. `task generate` writes `src/generated/events.ts`: one typed function for
   each event, named after its message. `beer_created(data, subject)` returns
   the CloudEvent, with its id, time, source and trace filled in, and throws
   if `data` is not what the contract says. `subject` is the id of the thing
   it happened to.
3. Write the event where the change is written, in `src/store/`
   ([store.md](store.md) has the transaction's rules):
   - Add `outbox(event)` (`src/lib/outbox.ts`) as one more item of the
     `TransactWriteCommand` that makes the change. A change made with a
     single `PutCommand` or `UpdateCommand` becomes a transaction of two
     items; a transaction cannot return the item, so read it afterwards.
   - Never write the event in a separate call, before or after: a failure
     between the two publishes something that did not happen, or loses
     something that did.
   - Build the event from what the transaction writes, not from a read that
     may be stale by the time it commits.
   - One change, one event. A consumer of the queue that makes the same
     change calls the same store function, so it publishes the same event.
4. Implement the steps with `steps/events.ts`:
   - `eventPublished(type, where?)` waits for an event of that type the
     scenario caused and returns it; narrow it with `where`, by `subject`.
     Never sleep.
   - `noEventPublished(type, where?)` waits until everything written has
     been published, then asserts no such event was. Use it for a refused
     request.
   - `published()` is every event since the scenario began; `forwarded()`
     waits until nothing is left to publish.
   - Every event published during a scenario is checked against the
     contract, whether or not a step looked at it.
5. `task features -- --tags @operation:<operation>` runs its scenarios.
   `task acceptance` then runs `publish:check`: an event of the contract no
   scenario saw published is a gap in the spec. Report it.

## What a subscriber is promised

An event is delivered at least once, and two events about one thing may
arrive out of order. Do not write code or steps that depend on more: assert
that an event was published, never that it was published exactly once after
a retry, or before another.

A sentence that says only one event of a kind was published is about what
the API wrote, not how often the bus delivered it: wait with
`eventPublished` and `forwarded()`, then count the distinct `id`s of that
type in `published()`.

## On the local stack

An event reaches the bus within a second or two of the write. `task
events:tail` follows what is published, `task outbox:list` shows what is
waiting, `task events:unpublished` what could not be published and why, and
`task events:retry` publishes those again. They work against `task dev`, and
against AWS with `ENV=aws`.
