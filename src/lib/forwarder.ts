// The forwarder: every event an operation wrote to the outbox is put on the
// EventBridge bus and then removed from the table. On the bus the CloudEvent
// is the `detail`; `detail-type` is its type and `source` its source, so a
// rule can select events without reading them.
//
// It never throws for one event. An event it cannot publish is put aside,
// with the reason, and the ones behind it carry on: on a stream, a record
// that keeps failing would otherwise hold up everything after it.
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent, DynamoDBStreamHandler } from "aws-lambda";
import type { CloudEvent } from "./cloudevents.ts";
import { dynamo, tableName } from "./dynamo.ts";
import { createLogger } from "./log.ts";
import { OUTBOX, outboxKey } from "./outbox.ts";

/** What the forwarder needs from outside itself; a test supplies its own. */
export type Dependencies = {
  /** Put the event on the bus; throw if the bus did not take it. */
  publish: (event: CloudEvent) => Promise<void>;
  /** Keep an event that could not be published, with why. */
  setAside: (event: unknown, reason: string) => Promise<void>;
  /** Remove the outbox item: the event is dealt with. */
  clear: (eventId: string) => Promise<void>;
};

const bus = new EventBridgeClient({});
// Through the endpoint the function is configured with, not the host in the queue's URL (see consumer.ts).
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

const defaults: Dependencies = {
  async publish(event) {
    const result = await bus.send(
      new PutEventsCommand({ Entries: [{ EventBusName: process.env.EVENT_BUS_NAME, Source: event.source, DetailType: event.type, Time: new Date(event.time), Detail: JSON.stringify(event) }] }),
    );
    const refused = result.Entries?.find((entry) => entry.ErrorCode);
    if (refused) throw new Error(`EventBridge refused the event: ${refused.ErrorCode} ${refused.ErrorMessage ?? ""}`.trim());
  },
  async setAside(event, reason) {
    await sqs.send(
      new SendMessageCommand({ QueueUrl: process.env.UNPUBLISHED_QUEUE_URL, MessageBody: JSON.stringify(event), MessageAttributes: { reason: { DataType: "String", StringValue: reason.slice(0, 1000) } } }),
    );
  },
  async clear(eventId) {
    await dynamo.send(new DeleteCommand({ TableName: tableName, Key: outboxKey(eventId) }));
  },
};

async function retried<T>(attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let remaining = tries; ; remaining--) {
    try {
      return await attempt();
    } catch (error) {
      if (remaining <= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** The event of a new outbox item, or undefined for any other change to the table. */
function outboxEvent(record: DynamoDBRecord): { id: string; event: unknown } | undefined {
  const pk = record.dynamodb?.Keys?.pk?.S ?? "";
  if (record.eventName !== "INSERT" || !pk.startsWith(OUTBOX)) return undefined;
  const item = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage as never) : {};
  return { id: pk.slice(OUTBOX.length), event: item.event };
}

export function createForwarder(given: Partial<Dependencies> = {}): DynamoDBStreamHandler {
  const { publish, setAside, clear } = { ...defaults, ...given };
  return async (batch: DynamoDBStreamEvent) => {
    // In the order they were written.
    for (const record of batch.Records) {
      const found = outboxEvent(record);
      if (!found) continue;
      const event = found.event as CloudEvent | undefined;
      const traceId = typeof event?.traceparent === "string" ? event.traceparent.split("-")[1] : undefined;
      const log = createLogger({ event_id: found.id, event_type: event?.type, trace_id: traceId });
      try {
        if (!event || typeof event.type !== "string" || typeof event.source !== "string") throw new Error("the outbox item holds no event");
        await retried(() => publish(event));
        log.info("event", { outcome: "published" });
      } catch (error) {
        // If it cannot even be put aside, fail: the stream offers the batch
        // again, and an event is never dropped in silence.
        await setAside(found.event ?? { id: found.id }, (error as Error).message);
        log.error("event", { outcome: "set_aside", error });
      }
      // Dealt with either way; a repeat of the record finds nothing to remove.
      await clear(found.id);
    }
  };
}
