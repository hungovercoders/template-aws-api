// The outbox: how an operation publishes. An event is not sent; it is written
// to the table in the same transaction as the operation's own data, so either
// both happen or neither does - never an event for a write that failed, never
// a write whose event was lost. The table's stream then hands it to the
// forwarder (src/lib/forwarder.ts), which puts it on the bus.
//
//   const event = beer_created({ beer_id, name }, beer_id);      // src/generated/events.ts
//   await dynamo.send(new TransactWriteCommand({ TransactItems: [yourWrite, outbox(event)] }));
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { CloudEvent } from "./cloudevents.ts";
import { tableName } from "./dynamo.ts";

/** Every outbox item's partition key starts with this; the stream and the forwarder's permissions select on it. */
export const OUTBOX = "outbox#";

export const outboxKey = (eventId: string) => ({ pk: `${OUTBOX}${eventId}`, sk: "event" });

type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/**
 * The write that publishes an event: one item of the transaction that makes
 * the change the event is about. Make the event with its function in
 * src/generated/events.ts, which holds it to the contract first.
 */
export function outbox(event: CloudEvent): TransactItem {
  return { Put: { TableName: tableName, Item: { ...outboxKey(event.id), event, written_at: new Date().toISOString() } } };
}

/** An event as an entry on the bus: the CloudEvent is the detail, and a rule can match on its type and source. */
export function busEntry(event: Pick<CloudEvent, "source" | "type"> & Partial<CloudEvent>, busName: string | undefined) {
  return { EventBusName: busName, Source: event.source, DetailType: event.type, Time: event.time ? new Date(event.time) : undefined, Detail: JSON.stringify(event) };
}
