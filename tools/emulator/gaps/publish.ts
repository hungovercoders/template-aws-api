// The emulator gaps that come with publishing events. All but the first are
// what keeps the publish component on a classic bus (#84).
import { CreateTableCommand, DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
  CreateEventBusCommand,
  CreateSubscriberCommand,
  type CreateSubscriberCommandInput,
  EventBridgeV2Client,
  ListTagsForResourceCommand,
  PutRawEventsCommand,
  TagResourceCommand,
  waitUntilEventBusActive,
} from "@aws-sdk/client-eventbridgev2";
import { CreateEventSourceMappingCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { type Gap, invocations, lambdaFunction, queue, received, role, sleep, terraform } from "../lib.ts";

const events = new EventBridgeV2Client({ maxAttempts: 1 });
const notImplemented = (error: unknown) => (error as Error).name === "NotImplemented";

async function bus(name: string): Promise<string> {
  const made = await events.send(new CreateEventBusCommand({ Name: name }));
  await waitUntilEventBusActive({ client: events, maxWaitTime: 30 }, { EventBusArn: made.EventBusArn });
  return made.EventBusArn!;
}

const cloudEvent = (id: string, type = "com.example.thing.changed.v1") => ({ specversion: "1.0", id, source: "/gap", type, time: "2026-01-01T00:00:00Z", subject: "thing-1", data: { id } });

// A CloudEvent published as it is: the call the move to the new bus is for.
async function publish(busArn: string, cloudEvents: object[]): Promise<void> {
  const entries = cloudEvents.map((event) => ({
    Data: new TextEncoder().encode(JSON.stringify(event)),
    SystemMetadata: { ContentType: "application/json", EventGroupId: "thing-1", DeduplicationId: (event as { id: string }).id },
  }));
  const put = await events.send(new PutRawEventsCommand({ EventBusArn: busArn, Entries: entries }));
  const failed = (put.Entries ?? []).filter((entry) => entry.ErrorCode);
  if (failed.length > 0) throw new Error(`PutRawEvents refused an entry: ${failed[0]?.ErrorCode} ${failed[0]?.ErrorMessage}`);
}

// One bus and one subscriber delivering to a queue, then the events; what the queue was sent.
async function delivered(name: string, cloudEvents: object[], subscriber: Partial<CreateSubscriberCommandInput>, fifo = false): Promise<string[] | "not-implemented"> {
  const busArn = await bus(name);
  const target = await queue(fifo ? `${name}.fifo` : name, fifo ? { FifoQueue: "true", ContentBasedDeduplication: "true" } : {});
  const invoke = { TargetArn: target.arn, RoleArn: await role(name), ...subscriber.InvokeConfiguration };
  await events.send(new CreateSubscriberCommand({ Name: name, EventBusArn: busArn, ...subscriber, InvokeConfiguration: invoke }));
  await sleep(1500);
  try {
    await publish(busArn, cloudEvents);
  } catch (error) {
    if (notImplemented(error)) return "not-implemented";
    throw error;
  }
  return received(target.url, 10, cloudEvents.length);
}

export const gaps: Gap[] = [
  {
    id: "stream-retry-limit",
    kind: "limit",
    gap: "A stream's event source mapping ignores `maximum_retry_attempts` and its on-failure destination: a failing batch is retried without end and never handed on.",
    then: "docs/testing.md says the stream's handling of a failed batch is not tested locally. A scenario could then show a failed event being retried and the ones behind it waiting.",
    where: ["infra/publish.tf", "docs/testing.md"],
    async test() {
      const name = "gap-stream-retry-limit";
      const table = await new DynamoDBClient({}).send(
        new CreateTableCommand({
          TableName: name,
          BillingMode: "PAY_PER_REQUEST",
          KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
          AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
          StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_IMAGE" },
        }),
      );
      const failures = await queue(`${name}-failures`);
      await lambdaFunction(name, await role(name), `export const handler = async () => { throw new Error("always"); };`);
      await new LambdaClient({}).send(
        new CreateEventSourceMappingCommand({
          EventSourceArn: table.TableDescription?.LatestStreamArn,
          FunctionName: name,
          StartingPosition: "TRIM_HORIZON",
          BatchSize: 1,
          MaximumRetryAttempts: 1,
          DestinationConfig: { OnFailure: { Destination: failures.arn } },
        }),
      );
      await sleep(3000);
      await new DynamoDBClient({}).send(new PutItemCommand({ TableName: name, Item: { pk: { S: "a" } } }));
      // On AWS the batch is tried twice, then given up on and a record of it sent to the queue.
      // A third try with nothing in the queue is the emulator going past the limit.
      for (const until = Date.now() + 60_000; Date.now() < until; ) {
        if ((await received(failures.url, 2)).length > 0) return false;
        if ((await invocations(name)) >= 3) return true;
      }
      throw new Error(`after a minute the function had been tried ${await invocations(name)} times and nothing was handed on: the mapping may not be delivering at all`);
    },
  },
  {
    id: "eventsv2-put-raw-events",
    kind: "blocked",
    gap: "On the new EventBridge custom event bus, PutRawEvents - the call that publishes a CloudEvent as it is - is not implemented, or what it delivers is not what was published.",
    then: "The forwarder publishes to a classic bus with the CloudEvent wrapped in `detail`. Unblocks moving the publish component to the new bus.",
    where: ["src/lib/outbox.ts", "infra/publish.tf"],
    issue: 84,
    async test() {
      const event = cloudEvent("e1");
      const got = await delivered("gap-eventsv2-put-raw-events", [event], {});
      if (got === "not-implemented") return true;
      return !(got.length === 1 && got[0] === JSON.stringify(event));
    },
  },
  {
    id: "eventsv2-filter",
    kind: "blocked",
    gap: "On the new bus, a subscriber's filter on a CloudEvent attribute (`type`) does not select raw-published events as AWS documents.",
    then: "Unblocks moving the publish component to the new bus: each subscriber takes its events by type.",
    where: ["infra/publish.tf"],
    issue: 84,
    async test() {
      const wanted = cloudEvent("e1");
      const filter = { Filters: [{ Scope: "DATA" as const, Pattern: JSON.stringify({ type: [wanted.type] }) }] };
      const got = await delivered("gap-eventsv2-filter", [cloudEvent("e0", "com.example.other.v1"), wanted], { FilterConfiguration: filter });
      if (got === "not-implemented") return true;
      return !(got.length === 1 && got[0] === JSON.stringify(wanted));
    },
  },
  {
    id: "eventsv2-ordered-delivery",
    kind: "blocked",
    gap: "On the new bus, a FIFO subscriber cannot take a FIFO queue's message group from the event's group, so ordered delivery cannot be shown.",
    then: "docs/spec.md promises subscribers no order. Unblocks moving the publish component to the new bus, where events about one thing arrive in order.",
    where: ["infra/publish.tf", "docs/spec.md"],
    issue: 84,
    async test() {
      const sent = ["e1", "e2", "e3", "e4", "e5"].map((id) => cloudEvent(id));
      const parameters = { SqsParameters: { MessageGroupId: "{% $events.SystemMetadata.EventGroupId %}" } };
      // The target is filled in by `delivered`; only the queue's parameters are this test's.
      const invoke = parameters as CreateSubscriberCommandInput["InvokeConfiguration"];
      const got = await delivered("gap-eventsv2-ordered-delivery", sent, { Type: "FIFO", InvokeConfiguration: invoke }, true);
      if (got === "not-implemented") return true;
      return got.join() !== sent.map((event) => JSON.stringify(event)).join();
    },
  },
  {
    id: "eventsv2-tags",
    kind: "blocked",
    gap: "On the new bus, a bus cannot be tagged or its tags read.",
    then: "Unblocks moving the publish component to the new bus: every resource carries the service's tags, and `task tags:check` holds infra/ to that.",
    where: ["infra/publish.tf", "infra/tags.tf"],
    issue: 84,
    async test() {
      const busArn = await bus("gap-eventsv2-tags");
      try {
        await events.send(new TagResourceCommand({ ResourceArn: busArn, Tags: { service: "gap" } }));
        const read = await events.send(new ListTagsForResourceCommand({ ResourceArn: busArn }));
        return read.Tags?.service !== "gap";
      } catch (error) {
        if (notImplemented(error)) return true;
        throw error;
      }
    },
  },
  {
    id: "eventsv2-terraform",
    kind: "blocked",
    gap: "The new bus and a subscriber cannot be applied with the awscc provider's eventsv2 resources.",
    then: "Unblocks moving the publish component to the new bus: infra/publish.tf declares the bus and its subscribers.",
    where: ["infra/publish.tf"],
    issue: 84,
    async test() {
      const applied = await terraform("eventsv2-terraform");
      if (applied.ok) return false;
      // Cloud Control not knowing the type at all is the gap; any other failure is the test's to explain.
      if (/TypeNotFoundException/.test(applied.output) && /awscc_eventsv2_/.test(applied.output)) return true;
      throw new Error(`the apply failed another way\n${applied.output.trim().slice(-1500)}`);
    },
  },
];
