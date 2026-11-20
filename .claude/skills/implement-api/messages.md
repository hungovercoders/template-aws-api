# Implementing messages the API receives

Read this when `specs/asyncapi.v<N>.yaml` has a `receive` operation. It adds to
the workflow in `SKILL.md`; nothing there changes.

The skeleton already takes a message from the queue, reads it as the
CloudEvent the contract describes, refuses one that does not match, makes
sure one delivered twice takes effect once, and tells the queue which
messages of a batch to offer again. Do not build any of that. You write what
a message means: one function in `src/consumers/<operation>.ts`, and steps.

## Workflow

1. `task asyncapi:check` and `task asyncapi:lint` must pass first. A failure
   is in the spec: report it, as for `spec:check`.
2. `task scaffold` writes a typed stub for each `receive` operation,
   `src/consumers/<operation>.ts`, and pending steps for the new sentences.
   `task test:unit` (`test/consumers.test.ts`) lists the stubs still to
   implement; delete a stub's `@scaffold` line when it is done.
3. Implement the consumer. It gets `{ event, log }`: `event` is the typed
   CloudEvent, already valid, and `event.data` is the payload.
   - Reuse the rule the HTTP operation uses - the same function in
     `src/domain/` or `src/store/` - so a message and a request cannot differ.
   - **Return** to accept the message.
   - **Throw `Rejected(reason)`** (`src/lib/consumer.ts`) for a message that
     is valid but can never be accepted: it names something that does not
     exist. It goes to the dead-letter queue at once, with the reason, and
     is tried again if someone redrives it.
   - **Throw anything else** for a failure that may pass: the message is
     offered again, and dead-lettered when it has been offered too often.
   - Do not check for duplicates: the skeleton has. Do not catch errors to
     log them: it logs every message once, with what became of it.
4. Implement the steps with `steps/messages.ts`:
   - `messageFor(operation, data, overrides?)` makes the CloudEvent a sender
     would; `deliver(operation, event)` puts it on the queue. Deliver the
     *same* event twice for a duplicate.
   - `eventually(assertion)` waits for what the message causes. Never sleep.
   - `settled()` waits until every message sent has been dealt with; use it
     before asserting that something did not happen.
   - `deadLetters()` reads the dead-letter queue, with each message's reason.
5. `task features -- --tags @operation:<operation>` runs its scenarios.
   `task acceptance` then runs `consume:check`: a `receive` operation no
   scenario delivered a message to is a gap in the spec. Report it.

## On the local stack

The queue gives a failing message two tries, five seconds apart, so a
scenario about one that keeps failing takes about ten seconds. A message
that is refused or rejected is dead-lettered at once.

`task queue:send -- <message>`, `task queue:peek`, `task dlq:peek` and
`task dlq:redrive` work against `task dev`, and against AWS with `ENV=aws`.
