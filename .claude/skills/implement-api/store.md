# Storing data in DynamoDB

Read this before writing `src/store/`. It adds to the workflow in
`SKILL.md`; nothing there changes.

Use `dynamo` (a DynamoDB document client) and `tableName` from
`src/lib/dynamo.ts`. The table (`infra/main.tf`) has string keys `pk` and
`sk` and two generic indexes, `gsi1` and `gsi2`: set `gsi1pk`/`gsi1sk` or
`gsi2pk`/`gsi2sk` on an item to put it in one. Both project every attribute,
so a Query on an index returns whole items.

- **Listing** - Query a key or an index; never Scan. To page, ask for one
  more item than the page size: its presence tells you there is a next page.
  A cursor should be opaque to callers and validated when it comes back
  (rule 4): check its structure and reject, with 400, anything that is not
  the shape you issue. It does not need signing - a caller who forges a
  well-formed cursor only gets a different page of data they may already read.
- **Consistency** - reads of the table can be strongly consistent
  (`ConsistentRead: true`); reads of an index cannot, on AWS. The emulator's
  indexes have behaved as immediately consistent, so list-after-write
  scenarios pass there. Listing from an index is the accepted trade-off; fetch a single item
  by key, consistently.
- **Atomic changes** - `TransactWriteCommand` is available, here and on the
  emulator, and is the way to keep several items in step (a record and the
  item that makes its name unique). A failed condition raises
  `TransactionCanceledException`, whose `CancellationReasons[i].Code` is
  `ConditionalCheckFailed` for the item that failed.
- **Concurrency** - any write, in or out of a transaction, can be refused
  because another transaction is touching the same item
  (`TransactionConflictException`, or the reason code `TransactionConflict`).
  Retry it, a bounded number of times (five is plenty) with a short, jittered
  pause. A write planned from a value you read earlier should carry a
  condition that the value is unchanged, and re-read and retry when it is
  not. If the retries run out, let the error through: the router logs it and
  answers 500, which is the truth.
- **Expressions** - many attribute names are reserved words (`name`, `status`,
  `type`...). Always use `ExpressionAttributeNames`.
