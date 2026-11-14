# Runbook

> **For** whoever is on call for a deployed API. **When** an alarm has fired, or you are setting up where alarms go.

## Alerting

Every stack is deployed with the same baseline alarms (`infra/alarms.tf`).
They exist from the first deploy; you only choose where they notify.

| Alarm | Fires when | Usually means |
| --- | --- | --- |
| `<name>-lambda-errors` | Any Lambda error in 5 minutes | An unhandled error, a timeout or out of memory |
| `<name>-lambda-throttles` | Any throttled invocation in 5 minutes | The concurrency limit was reached |
| `<name>-lambda-duration` | p99 duration above 80% of the timeout for 15 minutes | Timeouts are about to start |
| `<name>-api-5xx` | Any 5xx response in 5 minutes | The API failed, or API Gateway could not reach the Lambda |
| `<name>-api-latency` | p99 latency above 3 seconds for 15 minutes | Callers are waiting |
| `<name>-table-throttles` | Any throttled DynamoDB read or write in 5 minutes | The table is refusing work |
<!-- component:consume:start -->
| `<name>-queue-age` | The oldest message has waited longer than a message can take to be given up on, twice over | The consumer is failing, throttled or too slow |
| `<name>-dead-letters` | Any message on the dead-letter queue | A message could not be handled |
| `<name>-consumer-errors` | Any error of the consumer function in 5 minutes | An unhandled error, a timeout or out of memory |
| `<name>-consumer-throttles` | Any throttled invocation of the consumer in 5 minutes | The concurrency limit was reached |
<!-- component:consume:end -->

Each alarm notifies when it fires and again when it recovers. Routing:

```sh
task deploy NAME=my-api -- -var alarm_email=oncall@example.com        # email; the address must confirm
task deploy NAME=my-api -- -var alarm_topic_arn=arn:aws:sns:...        # your existing topic instead
```

With neither, the alarms still exist and notify the stack's own topic
(`alarm_topic_arn` in the outputs), which you can subscribe a chat or on-call
tool to. In the CI deploy job, set the repository variables `ALARM_EMAIL` or
`ALARM_TOPIC_ARN`.

Thresholds are strict on purpose: a new API should be quiet, and an alarm you
learn to ignore is worse than none. The unexpected error behind a
`lambda-errors` or `api-5xx` alarm is in the logs with its `request_id`.
Alarms on business outcomes - orders failing, sign-ups dropping - are yours
to add; these cover the platform.

## When an alarm fires

Find the alarm's name in the notification and go to its entry. Every entry
starts from the same place: the Lambda's log group, `/aws/lambda/<name>`, in
CloudWatch Logs Insights. Each request is one JSON line with `request_id`,
`operation_id`, `status`, `duration_ms` and `api_version`; an unexpected
error is a line with `level` `error` and the same `request_id`.

```
fields @timestamp, operation_id, status, duration_ms, request_id
| filter level = "error" or status >= 500
| sort @timestamp desc
```

An alarm notifies again when it recovers. If it fired once and recovered on
its own, read the entry anyway: the cause is still in the logs.

### lambda-errors

**Means** an invocation failed outright: an unhandled error, a timeout, or
out of memory. Callers got a 5xx.

1. Run the query above. An `unhandled error` line names the operation and
   carries the stack.
2. No error line but `Task timed out` or `Runtime exited` in the raw log:
   the Lambda hit its timeout or memory limit - see `lambda-duration`.
3. Started right after a deploy: redeploy the previous commit, then debug.

**Usually** a bug on an input no scenario covers. Reproduce it with a
feature scenario first, then fix; the fuzz gate should have a chance to find
the next one.

### lambda-throttles

**Means** requests were refused because the Lambda reached its concurrency
limit. Callers got 429 or 5xx.

1. Check whether traffic rose (API Gateway `Count`) or each request got
   slower (`lambda-duration`), since slow requests hold concurrency longer.
2. Check the account's concurrent-execution limit and whether another
   function is using it.

**Usually** a traffic spike or a slow dependency. Raise the account limit or
give the function reserved concurrency in `infra/main.tf`.

### lambda-duration

**Means** the slowest 1% of invocations are within 20% of the timeout.
Timeouts - and `lambda-errors` - are next.

1. Find the slow operations:
   `stats pct(duration_ms, 99) by operation_id`.
2. Check `table-throttles`: DynamoDB retries look like slowness first.
3. Check for a listing that reads more than a page, or a retry loop.

**Usually** a query that grew with the data, or throttling. Fix the query;
raise `timeout` or `memory_size` in `infra/main.tf` only once you know why.

### api-5xx

**Means** callers received a 5xx from the API.

1. If `lambda-errors` also fired, start there - it is the same incident.
2. If not, API Gateway could not use the Lambda: check the function exists,
   its permission for API Gateway, and whether a deploy is in progress.
3. Find which operations: `filter status >= 500 | stats count() by operation_id`.

**Usually** the same bug as `lambda-errors`. On its own, a broken or
half-finished deploy.

### api-latency

**Means** the slowest 1% of requests took over 3 seconds for 15 minutes.
Nothing is failing yet; callers are waiting.

1. Compare with the Lambda's `Duration`. Close together: the time is in your
   code - see `lambda-duration`. Far apart: cold starts or API Gateway.
2. Cold starts show as `Init Duration` in the raw log, after quiet periods.

**Usually** the same cause as `lambda-duration`. If it is cold starts,
raising `memory_size` shortens them.

### table-throttles

**Means** DynamoDB refused reads or writes on the table. The SDK retries, so
callers see slowness before errors.

1. The table is on-demand, so this is a sudden surge or a hot key: many
   requests for one partition.
2. Look for an operation that reads or writes one item far more than the
   others, or a listing that pulls a whole partition.

**Usually** a hot partition: one item everything touches, or a list that
grew. Spread the key or page the read. A brief burst after a long quiet
spell is DynamoDB scaling up and clears on its own.

<!-- component:consume:start -->
## Messages

The consumer's log group is `/aws/lambda/<name>-consumer`. Every message is
one JSON line, `message`, with `message_id`, `event_id`, `event_type`,
`operation_id`, `receive_count`, `trace_id` and its `outcome`: `handled`,
`duplicate`, `busy`, `failed` or `dead_lettered` (with the `reason`).

```
fields @timestamp, outcome, operation_id, event_type, event_id, reason, receive_count
| filter message = "message" and outcome not in ["handled", "duplicate"]
| sort @timestamp desc
```

### dead-letters

**Means** a message is on the dead-letter queue, where it stays for 14 days.
Nothing is lost yet, and nothing else is held up.

1. `ENV=aws task dlq:peek` shows each message and its `reason`.
2. A reason about the contract: the sender sent something the contract does
   not describe. That is the sender's to fix; tell them, with the message.
3. A reason from a consumer (`Rejected`): the message named something that
   does not exist here. Decide with the sender whether it matters.
4. No reason: the message failed every time it was offered. Find its
   `event_id` in the query above; the `failed` lines carry the error.
5. Once the cause is fixed, `ENV=aws task dlq:redrive` sends them round again.

**Usually** a sender and this API disagreeing about the contract. Compare
the message with `specs/asyncapi.yaml` and with `messages/`.

### queue-age

**Means** messages are waiting much longer than it takes to handle one.

1. `ENV=aws task queue:peek`: how many are waiting, how many being handled.
2. Check `consumer-errors` and `consumer-throttles`; either explains it.
3. Neither: the consumer is slower than messages arrive. Its duration is in
   the `handled` lines.

**Usually** a consumer that fails on every message, so each waits out its
retries. Fix the failure; the queue then drains on its own.

### consumer-errors

**Means** the consumer function failed outright: an unhandled error, a
timeout or out of memory. The messages it held are offered again.

1. Run the query above for `failed` lines, then look for `Task timed out`
   or `Runtime exited` in the raw log.
2. Started right after a deploy: redeploy the previous commit, then debug.

**Usually** a bug on a message no scenario covers. Write the scenario first.

### consumer-throttles

**Means** the consumer was refused concurrency. Messages wait; none is lost.
See `lambda-throttles`: the cause and the remedy are the same.
<!-- component:consume:end -->
