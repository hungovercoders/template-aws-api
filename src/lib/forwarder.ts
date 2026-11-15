// The forwarder: every event an operation wrote to the outbox is put on the
// EventBridge bus and then removed from the table. On the bus the CloudEvent
// is the `detail`; `detail-type` is its type and `source` its source, so a
// rule can select events without reading them.
//
// Two kinds of failure, told apart:
// - the bus will never take this event (it is malformed, or too large): it
//   is put aside with the reason, and the ones behind it carry on;
// - anything that may pass (the bus is throttling or down, a permission is
//   missing): the forwarder stops there and tells the stream which record
//   to start again from. Events stay in order and none is put aside for a
//   fault that is not its own.
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { Context, DynamoDBBatchResponse, DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import type { CloudEvent } from "./cloudevents.ts";
import { dynamo, tableName } from "./dynamo.ts";
import { createLogger } from "./log.ts";
import { OUTBOX, busEntry, outboxKey } from "./outbox.ts";

/** What the forwarder needs from outside itself; a test supplies its own. */
export type Dependencies = {
  /** Put the event on the bus; throw `Unpublishable` if the bus will never take it, anything else if it may yet. */
  publish: (event: CloudEvent) => Promise<void>;
  /** Keep an event that could not be published, with why. */
  setAside: (event: unknown, reason: string) => Promise<void>;
  /** Remove the outbox item: the event is dealt with. */
  clear: (eventId: string) => Promise<void>;
};

/** The bus will never take this event, however often it is offered. */
export class Unpublishable extends Error {}

const bus = new EventBridgeClient({});
// Through the endpoint the function is configured with, not the host in the queue's URL (see consumer.ts).
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

// What EventBridge says of one entry when the fault is the bus's own and may pass.
const PASSING = /Internal|Throttl|LimitExceeded|Unavailable/i;
// Leave this long to tell the stream where to start again.
const MARGIN_MS = 10_000;

const defaults: Dependencies = {
  async publish(event) {
    let result;
    try {
      result = await bus.send(new PutEventsCommand({ Entries: [busEntry(event, process.env.EVENT_BUS_NAME)] }));
    } catch (error) {
      // The request itself was refused as invalid: an event larger than the bus takes.
      if ((error as Error).name === "ValidationException") throw new Unpublishable(`EventBridge refused the event: ${(error as Error).message}`);
      throw error;
    }
    const refused = result.Entries?.find((entry) => entry.ErrorCode);
    if (!refused) return;
    const reason = `EventBridge refused the event: ${refused.ErrorCode} ${refused.ErrorMessage ?? ""}`.trim();
    throw PASSING.test(refused.ErrorCode ?? "") ? new Error(reason) : new Unpublishable(reason);
  },
  async setAside(event, reason) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: process.env.UNPUBLISHED_QUEUE_URL,
        MessageBody: JSON.stringify(event),
        MessageAttributes: { reason: { DataType: "String", StringValue: (reason || "no reason was given").slice(0, 1000) } },
      }),
    );
  },
  async clear(eventId) {
    await dynamo.send(new DeleteCommand({ TableName: tableName, Key: outboxKey(eventId) }));
  },
};

/** The event of a new outbox item, or undefined for any other change to the table. */
function outboxEvent(record: DynamoDBRecord): { id: string; event: unknown; unreadable?: string } | undefined {
  const pk = record.dynamodb?.Keys?.pk?.S ?? "";
  if (record.eventName !== "INSERT" || !pk.startsWith(OUTBOX)) return undefined;
  const id = pk.slice(OUTBOX.length);
  try {
    const item = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage as never) : {};
    // Whatever was written must also survive being sent.
    JSON.stringify(item.event);
    return { id, event: item.event };
  } catch (error) {
    return { id, event: undefined, unreadable: `the outbox item cannot be read: ${(error as Error).message}` };
  }
}

export function createForwarder(given: Partial<Dependencies> = {}) {
  const { publish, setAside, clear } = { ...defaults, ...given };
  return async (batch: DynamoDBStreamEvent, context?: Pick<Context, "getRemainingTimeInMillis">): Promise<DynamoDBBatchResponse> => {
    // In the order they were written.
    for (const record of batch.Records) {
      const found = outboxEvent(record);
      if (!found) continue;
      // Where the stream starts again: this record and everything after it.
      const again = (): DynamoDBBatchResponse => {
        const sequence = record.dynamodb?.SequenceNumber;
        if (!sequence) throw new Error("the forwarder could not finish the batch, and the record has no sequence number to start again from");
        return { batchItemFailures: [{ itemIdentifier: sequence }] };
      };
      // Not enough time left to be sure of one more: stop cleanly rather than time out.
      if (context?.getRemainingTimeInMillis && context.getRemainingTimeInMillis() < MARGIN_MS) return again();
      const event = found.event as CloudEvent | undefined;
      const traceId = typeof event?.traceparent === "string" ? event.traceparent.split("-")[1] : undefined;
      const log = createLogger({ event_id: found.id, event_type: event?.type, trace_id: traceId });
      try {
        try {
          if (found.unreadable) throw new Unpublishable(found.unreadable);
          if (!event || typeof event.type !== "string" || typeof event.source !== "string") throw new Unpublishable("the outbox item holds no event");
          await publish(event);
          log.info("event", { outcome: "published" });
        } catch (error) {
          if (!(error instanceof Unpublishable)) throw error;
          await setAside(found.event ?? { id: found.id }, error.message);
          log.error("event", { outcome: "set_aside", error });
        }
        // Dealt with either way; a repeat of the record finds nothing to remove.
        await clear(found.id);
      } catch (error) {
        // It may pass. Nothing is dropped, and nothing behind it overtakes it.
        log.error("event", { outcome: "retrying", error });
        return again();
      }
    }
    return { batchItemFailures: [] };
  };
}
