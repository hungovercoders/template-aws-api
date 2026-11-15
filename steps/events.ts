// What scenarios about published events share: waiting for an event the API
// published, and making sure nothing was. Every event the API publishes while
// the scenarios run is read from its log and held to the contract, whether or
// not a step looked at it.
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { After, AfterAll, Before } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { asyncOperations } from "../src/generated/async-operations.ts";
import { type CloudEvent, events } from "../src/lib/cloudevents.ts";
import { dynamo, tableName } from "../src/lib/dynamo.ts";
import { OUTBOX } from "../src/lib/outbox.ts";

const logs = new CloudWatchLogsClient({});
/** Set by local/stack.mjs from the stack's outputs. */
const group = () => process.env.EVENT_LOG_GROUP || assert.fail("EVENT_LOG_GROUP is not set - run the scenarios with `task features`, which brings up the stack");
const publishes = (asyncOperations as readonly { action: string }[]).some((operation) => operation.action === "send");

/** Every type a scenario saw published, for `task publish:check`. */
const seen = new Set<string>();
/** When the scenario began: an event is this scenario's if it happened since. */
let began = 0;

/** Every event published since the scenario began, oldest first. */
export async function published(): Promise<CloudEvent[]> {
  const found: CloudEvent[] = [];
  let next: string | undefined;
  do {
    // A little before the scenario began: the log's clock is not the scenario's.
    const page = await logs.send(new FilterLogEventsCommand({ logGroupName: group(), startTime: began - 60_000, nextToken: next }));
    for (const line of page.events ?? []) {
      const event = (JSON.parse(line.message ?? "{}") as { detail?: CloudEvent }).detail;
      if (event && Date.parse(event.time) >= began) found.push(event);
    }
    next = page.nextToken;
  } while (next);
  for (const event of found) seen.add(event.type);
  return found.sort((a, b) => a.time.localeCompare(b.time));
}

async function tried<T>(assertion: () => Promise<T> | T, timeout: number, every = 200): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() + every > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, every));
    }
  }
}

/**
 * Wait for an event of a type to be published, and return it - the latest,
 * if there are several. `where` picks among them: (event) => event.subject === id.
 */
export function eventually(type: string, where: (event: CloudEvent) => boolean = () => true, { timeout = 15_000 } = {}): Promise<CloudEvent> {
  return tried(async () => {
    const matching = (await published()).filter((event) => event.type === type && where(event));
    assert.ok(matching.length > 0, `no ${type} event was published`);
    return matching.at(-1)!;
  }, timeout);
}

/** Wait until nothing is left in the outbox: every event written so far has been dealt with. */
export async function forwarded({ timeout = 15_000 } = {}): Promise<void> {
  await tried(async () => {
    const waiting = await dynamo.send(
      new ScanCommand({ TableName: tableName, FilterExpression: "begins_with(pk, :outbox)", ExpressionAttributeValues: { ":outbox": OUTBOX }, ProjectionExpression: "pk", ConsistentRead: true }),
    );
    assert.equal(waiting.Items?.length ?? 0, 0, "events are still waiting in the outbox");
  }, timeout);
}

/**
 * Assert that nothing of a type was published. Absence can only be shown by
 * waiting: for the outbox to empty, then a moment more for the bus to deliver.
 */
export async function never(type: string, where: (event: CloudEvent) => boolean = () => true): Promise<void> {
  await forwarded();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const matching = (await published()).filter((event) => event.type === type && where(event));
  assert.deepEqual(matching, [], `a ${type} event was published`);
}

Before(function () {
  began = Date.now();
});

// Everything published during the scenario is what the contract says it is.
After(async function () {
  if (!publishes) return;
  await forwarded();
  for (const event of await published()) {
    assert.deepEqual(events.wrongWith(event), [], `the published ${event.type} event broke the contract:\n  ${JSON.stringify(event)}`);
  }
});

AfterAll(function () {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/events-published.json", JSON.stringify([...seen].sort(), null, 2) + "\n");
});
