// The queue consumer. The skeleton does what is the same for every message:
// it reads each one as the CloudEvent the contract says this API accepts,
// makes sure a message delivered twice takes effect once, hands it to the
// operation's own function in src/consumers/, and tells the queue which
// messages of a batch to offer again. What a message means is yours.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from "aws-lambda";
import { asyncOperations } from "../generated/async-operations.ts";
import { type CloudEvent, InvalidEvent, events } from "./cloudevents.ts";
import { dynamo, tableName } from "./dynamo.ts";
import { createLogger, type Logger } from "./log.ts";
import { traceId } from "./trace.ts";

/** A message that has already passed contract validation. */
export type MessageContext<Event extends CloudEvent = CloudEvent> = {
  event: Event;
  /** Writes structured lines that carry this message's id, type and trace. */
  log: Logger;
};
/**
 * Throw this from a consumer for a message that is valid by the contract but
 * can never be accepted - it names something that does not exist, say. It is
 * put on the dead-letter queue at once, with the reason, instead of being
 * offered again until the queue gives up on it.
 */
export class Rejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "Rejected";
  }
}

export type Consumer<Event extends CloudEvent = CloudEvent> = (context: MessageContext<Event>) => Promise<void>;
/** Each `receive` operation of the contract, by name. Generated: src/generated/consumers.ts. */
export type Consumers = Record<string, Consumer<never> | undefined>;

/** What the consumer needs from outside itself; a test supplies its own. */
export type Dependencies = {
  /** The CloudEvent a message is, or InvalidEvent. */
  parse: (body: string) => CloudEvent;
  /** The `receive` operation that handles a type. */
  operationFor: (type: string) => string | undefined;
  claims: Claims;
  /** Put a message that can never succeed aside, with why. */
  deadLetter: (record: SQSRecord, reason: string) => Promise<void>;
};

/**
 * One message, once. A message is claimed before it is handled and the claim
 * is kept when handling succeeds, so a second delivery finds it and stops.
 */
export type Claims = {
  /** "claimed" to go ahead; "done" if it was handled before; "busy" if another delivery is handling it now. */
  claim: (key: string) => Promise<"claimed" | "done" | "busy">;
  complete: (key: string) => Promise<void>;
  /** Handling failed: give the claim up, so the next delivery can try. */
  release: (key: string) => Promise<void>;
};

const DAY = 24 * 60 * 60;
/** How long a handled message is remembered. SQS keeps a message at most 14 days, so none can outlive it. */
const REMEMBER = 14 * DAY;

/** Claims kept in the table, under keys of their own. `lease` is how long one delivery may take, in seconds. */
export function tableClaims(lease = Number(process.env.AWS_LAMBDA_FUNCTION_TIMEOUT ?? 30)): Claims {
  const keyOf = (key: string) => ({ pk: `message#${key}`, sk: "message" });
  const now = () => Math.floor(Date.now() / 1000);
  return {
    async claim(key) {
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...keyOf(key), state: "handling", lease_until: now() + lease, expires_at: now() + REMEMBER },
            // Free, or left by a delivery that died before it could give it up.
            ConditionExpression: "attribute_not_exists(pk) OR (#state = :handling AND lease_until < :now)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":handling": "handling", ":now": now() },
          }),
        );
        return "claimed";
      } catch (error) {
        // By name: the function runs on the SDK its runtime provides.
        if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
        const held = await dynamo.send(new GetCommand({ TableName: tableName, Key: keyOf(key), ConsistentRead: true }));
        return held.Item?.state === "done" ? "done" : "busy";
      }
    },
    async complete(key) {
      await dynamo.send(
        new UpdateCommand({
          TableName: tableName,
          Key: keyOf(key),
          UpdateExpression: "SET #state = :done REMOVE lease_until",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":done": "done" },
        }),
      );
    },
    async release(key) {
      const mine = { ConditionExpression: "#state = :handling", ExpressionAttributeNames: { "#state": "state" }, ExpressionAttributeValues: { ":handling": "handling" } };
      await dynamo.send(new DeleteCommand({ TableName: tableName, Key: keyOf(key), ...mine })).catch((error: Error) => {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      });
    },
  };
}

// Through the endpoint the function is configured with, not the host in the
// queue's URL: on AWS they are the same, and AWS Emulator gives its queues
// URLs that name AWS itself.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
async function sendToDeadLetterQueue(record: SQSRecord, reason: string): Promise<void> {
  const fifo = record.attributes?.MessageGroupId;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: process.env.DEAD_LETTER_QUEUE_URL,
      MessageBody: record.body,
      MessageAttributes: { reason: { DataType: "String", StringValue: reason.slice(0, 1000) } },
      ...(fifo ? { MessageGroupId: fifo, MessageDeduplicationId: record.messageId } : {}),
    }),
  );
}

// Generated from the contract; empty, and so of no particular shape, when the API accepts nothing.
const operationTable = asyncOperations as readonly { id: string; action: string; messages: readonly { type?: string }[] }[];

const defaults: Dependencies = {
  parse: (body) => events.parse(body),
  operationFor: (type) => operationTable.find((operation) => operation.action === "receive" && operation.messages.some((message) => message.type === type))?.id,
  claims: tableClaims(),
  deadLetter: sendToDeadLetterQueue,
};

export function createConsumer(consumers: Consumers, given: Partial<Dependencies> = {}): SQSHandler {
  const { parse, operationFor, claims, deadLetter } = { ...defaults, ...given };

  /** True when the message is dealt with: handled, a duplicate, or put aside. False to have it offered again. */
  async function handle(record: SQSRecord): Promise<boolean> {
    const started = Date.now();
    const base = { message_id: record.messageId, receive_count: Number(record.attributes?.ApproximateReceiveCount ?? 1) };
    let event: CloudEvent;
    try {
      // Also carries on the trace the message came with.
      event = parse(record.body);
    } catch (error) {
      if (!(error instanceof InvalidEvent)) throw error;
      // It can never succeed, so offering it again would only delay the answer.
      await deadLetter(record, error.message);
      createLogger(base).warn("message", { outcome: "dead_lettered", reason: error.message });
      return true;
    }
    const operation = operationFor(event.type);
    const log = createLogger({ ...base, trace_id: traceId(), event_id: event.id, event_type: event.type, operation_id: operation });
    const consumer = operation === undefined ? undefined : (consumers[operation] as Consumer | undefined);
    if (!consumer) {
      await deadLetter(record, `no consumer for ${event.type}`);
      log.error("message", { outcome: "dead_lettered", reason: "the contract accepts this type but nothing handles it" });
      return true;
    }
    // A CloudEvent's id is unique for its source.
    const key = `${event.source}#${event.id}`;
    const claim = await claims.claim(key);
    if (claim !== "claimed") {
      log.info("message", { outcome: claim === "done" ? "duplicate" : "busy" });
      return claim === "done";
    }
    try {
      await consumer({ event, log });
      await claims.complete(key);
      log.info("message", { outcome: "handled", duration_ms: Date.now() - started });
      return true;
    } catch (error) {
      if (error instanceof Rejected) {
        await deadLetter(record, error.reason);
        // Not remembered as handled: redriven once its cause is fixed, it is tried again.
        await claims.release(key);
        log.warn("message", { outcome: "dead_lettered", reason: error.reason, duration_ms: Date.now() - started });
        return true;
      }
      await claims.release(key);
      log.error("message", { outcome: "failed", error, duration_ms: Date.now() - started });
      return false;
    }
  }

  return async (batch: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    // One at a time: the trace in force is one message's.
    for (const record of batch.Records) {
      const dealtWith = await handle(record).catch((error) => {
        createLogger({ message_id: record.messageId }).error("message", { outcome: "failed", error });
        return false;
      });
      if (!dealtWith) batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    return { batchItemFailures };
  };
}
