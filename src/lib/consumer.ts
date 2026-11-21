// The queue consumer. The skeleton does what is the same for every message:
// it reads each one as the CloudEvent the contract says this API accepts,
// makes sure a message delivered twice takes effect once, hands it to the
// operation's own function in src/consumers/, and tells the queue which
// messages of a batch to offer again. What a message means is yours.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import type { SQSBatchResponse, SQSEvent, SQSHandler, SQSRecord } from "aws-lambda";
import { asyncOperations } from "../generated/async-operations.ts";
import { type CloudEvent, InvalidEvent, events } from "./cloudevents.ts";
import { dynamo, tableName } from "./dynamo.ts";
import { createLogger, type Logger } from "./log.ts";

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

/**
 * Claims kept in the table, under keys of their own. `lease` is how long one
 * delivery may hold a claim, in seconds: the consumer's timeout, since no
 * delivery can run longer. A claim left by one that died is free after that.
 */
export function tableClaims(lease = Number(process.env.CONSUME_TIMEOUT ?? 30)): Claims {
  const keyOf = (key: string) => ({ pk: `message#${key}`, sk: "message" });
  const now = () => Math.floor(Date.now() / 1000);
  // Each claim this instance holds is its own: only its holder may keep or drop it.
  const held = new Map<string, string>();
  const mine = (key: string) => ({
    ConditionExpression: "#state = :handling AND holder = :holder",
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: { ":handling": "handling", ":holder": held.get(key) ?? "" },
  });
  const unlessLost = (error: Error) => {
    // By name: the function runs on the SDK its runtime provides.
    if (error.name !== "ConditionalCheckFailedException") throw error;
  };
  return {
    async claim(key) {
      const holder = randomUUID();
      try {
        await dynamo.send(
          new PutCommand({
            TableName: tableName,
            // Its own name for the expiry: an API's items may well have an expires_at.
            Item: { ...keyOf(key), state: "handling", holder, lease_until: now() + lease, message_claim_expires_at: now() + REMEMBER },
            // Free, or left by a delivery that died before it could give it up.
            ConditionExpression: "attribute_not_exists(pk) OR (#state = :handling AND lease_until < :now)",
            ExpressionAttributeNames: { "#state": "state" },
            ExpressionAttributeValues: { ":handling": "handling", ":now": now() },
          }),
        );
        held.set(key, holder);
        return "claimed";
      } catch (error) {
        if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
        const existing = await dynamo.send(new GetCommand({ TableName: tableName, Key: keyOf(key), ConsistentRead: true }));
        return existing.Item?.state === "done" ? "done" : "busy";
      }
    },
    async complete(key) {
      const { ExpressionAttributeValues, ...condition } = mine(key);
      await dynamo
        .send(new UpdateCommand({ TableName: tableName, Key: keyOf(key), UpdateExpression: "SET #state = :done REMOVE lease_until, holder", ...condition, ExpressionAttributeValues: { ...ExpressionAttributeValues, ":done": "done" } }))
        .catch(unlessLost);
      held.delete(key);
    },
    async release(key) {
      await dynamo.send(new DeleteCommand({ TableName: tableName, Key: keyOf(key), ...mine(key) })).catch(unlessLost);
      held.delete(key);
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

async function retried<T>(attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let remaining = tries; ; remaining--) {
    try {
      return await attempt();
    } catch (error) {
      if (remaining <= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

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
    const log = createLogger({ ...base, event_id: event.id, event_type: event.type, operation_id: operation });
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
    // The message has taken effect. Whatever happens now it is not offered
    // again: failing to record that must not make it take effect twice.
    try {
      await retried(() => claims.complete(key));
    } catch (error) {
      log.error("the message was handled but could not be recorded as handled; a later delivery of it would be handled again", { error });
    }
    log.info("message", { outcome: "handled", duration_ms: Date.now() - started });
    return true;
  }

  return async (batch: SQSEvent): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
    // One at a time: the trace in force is one message's.
    // A FIFO queue promises order: once one message fails, none after it in
    // the batch is handled before it is tried again.
    const ordered = batch.Records.some((record) => record.attributes?.MessageGroupId !== undefined);
    for (const record of batch.Records) {
      if (ordered && batchItemFailures.length > 0) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }
      const dealtWith = await handle(record).catch((error) => {
        createLogger({ message_id: record.messageId }).error("message", { outcome: "failed", error });
        return false;
      });
      if (!dealtWith) batchItemFailures.push({ itemIdentifier: record.messageId });
    }
    return { batchItemFailures };
  };
}
