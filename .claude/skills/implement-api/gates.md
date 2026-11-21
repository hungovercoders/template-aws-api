# Running the gates

Part of the `implement-api` skill: read it before `task features` and `task contract:fuzz`, and when a gate that uses the stack fails.

## What the fuzzer sends

Schemathesis generates whatever the contract allows, and a good deal it does
not. Before `task contract:fuzz`, check your code against:

- **Any text a string schema allows** - control characters, emoji, text that
  is all punctuation, very long values up to `maxLength`. Anything that ends
  up in a key must cope: a sort key is limited to 1024 bytes.
- **Numbers at the edges** - the minimum and maximum, `-0`, values with many
  decimal places, values too small for DynamoDB to store unless you round.
- **Random values for opaque strings** such as cursors and ids. They must get
  a documented 4xx, never a 500.
- **Every documented status is fair game** - if your code can answer with a
  status the contract does not document for that operation, that is a failure.

## Running the gates

`task` installs what it needs the first time, AWS Emulator included - on macOS it builds
the emulator's Docker image, so Docker Desktop must be running; the other tools come from
`mise install`. If the emulator will not start, connect or
sign, use the `aws-emulator` skill - but never upgrade it; its version is pinned.

The scenarios and the fuzz run call the API through AWS Emulator's API
Gateway, authorizer and Lambda - the built bundle is the function. Its Node
runtime is not the whole of Node, and a unit test cannot see the difference:

- no `node:http`, `node:https` or `node:module` - a dependency that needs
  one fails every request with `Runtime.ImportModuleError`;
- no `structuredClone`, and decoding malformed base64 throws: parse
  anything a caller supplies inside try/catch;
- it runs on the AWS SDK the runtime provides, so tell SDK errors by
  `error.name`, not `instanceof` ([store.md](store.md) has the rest).

When a task that uses the stack fails it prints what the functions logged,
errors first (it needs the AWS CLI): read that before guessing why a request
answered 500. `task emulator:gaps:list` names what else the emulator cannot
do yet; read it before deciding the emulator, not your code, is at fault.

If the local stack cannot run where you are working, `task check`,
`task build`, `task infra:validate` and the cucumber dry run still do, and
`handler` from `dist/handler.mjs` can be called with an event. That is not
done: say so in your report, and leave the features and fuzz gates to CI.
