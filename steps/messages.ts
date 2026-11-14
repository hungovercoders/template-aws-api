// What scenarios about messages share: sending one to the API's queue as
// another service would, waiting for what follows, and reading what was put
// on the dead-letter queue. Step definitions call these; add yours next to
// this file.
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { AfterAll, Before } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { asyncOperations } from "../src/generated/async-operations.ts";
import type { CloudEvent } from "../src/lib/cloudevents.ts";

// The queue is reached through the endpoint the stack configures, not the host
// in its URL: AWS Emulator gives its queues URLs that name AWS itself.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });
/** Set by local/stack.mjs from the stack's outputs. */
const queue = () => process.env.QUEUE_URL ?? assert.fail("QUEUE_URL is not set - run the scenarios with `task features`, which brings up the stack");
const deadLetterQueue = () => process.env.DEAD_LETTER_QUEUE_URL ?? assert.fail("DEAD_LETTER_QUEUE_URL is not set - run the scenarios with `task features`");

type Receive = { id: string; action: string; messages: readonly { name: string; type?: string }[] };
const receives = (asyncOperations as readonly Receive[]).filter((operation) => operation.action === "receive");

/** Every receive operation a scenario delivered a message to, for `task consume:check`. */
const delivered = new Set<string>();

/**
 * A message as a sender would make it: the CloudEvent envelope around `data`,
 * for the one message the operation accepts. `overrides` replaces any part of
 * it - to send the same event twice, or one that breaks the contract.
 */
export function messageFor(operationId: string, data: unknown, overrides: Partial<CloudEvent> = {}): CloudEvent {
  const operation = receives.find((candidate) => candidate.id === operationId);
  assert.ok(operation, `${operationId} is not a receive operation in specs/asyncapi.yaml`);
  const type = operation.messages[0]?.type;
  assert.ok(type, `${operationId} has no message with a type`);
  return { specversion: "1.0", id: randomUUID(), source: "/scenario", type, time: new Date().toISOString(), datacontenttype: "application/json", data, ...overrides };
}

/** Put a message on the queue. `body` is a CloudEvent, or anything at all for a message that should be refused. */
export async function deliver(operationId: string, body: unknown): Promise<void> {
  assert.ok(receives.some((operation) => operation.id === operationId), `${operationId} is not a receive operation in specs/asyncapi.yaml`);
  await sqs.send(new SendMessageCommand({ QueueUrl: queue(), MessageBody: typeof body === "string" ? body : JSON.stringify(body) }));
  delivered.add(operationId);
}

/**
 * Wait for something a message causes. The assertion is tried until it
 * passes; when time runs out its last failure is the step's failure. Never a
 * sleep: a scenario waits exactly as long as the API takes.
 */
export async function eventually<T>(assertion: () => Promise<T> | T, { timeout = 15_000, every = 200 } = {}): Promise<T> {
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
 * Wait until the queue is empty and nothing is being handled: every message
 * sent so far has been dealt with, one way or another. Use it before
 * asserting that something did NOT happen - a duplicate that changed nothing.
 */
export async function settled(options?: { timeout?: number; every?: number }): Promise<void> {
  await eventually(async () => {
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queue(), AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    assert.deepEqual([Attributes?.ApproximateNumberOfMessages, Attributes?.ApproximateNumberOfMessagesNotVisible], ["0", "0"], "messages are still waiting on the queue or being handled");
  }, options);
}

export type DeadLetter = { body: string; reason: string | undefined };

/** What is on the dead-letter queue now. Messages stay there; reading them does not take them. */
export async function deadLetters(): Promise<DeadLetter[]> {
  const found: DeadLetter[] = [];
  for (;;) {
    const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: deadLetterQueue(), MaxNumberOfMessages: 10, VisibilityTimeout: 1, WaitTimeSeconds: 0, MessageAttributeNames: ["All"] }));
    if (!page.Messages?.length) return found;
    found.push(...page.Messages.map((message) => ({ body: message.Body ?? "", reason: message.MessageAttributes?.reason?.StringValue })));
  }
}

// Take everything off a queue, and wait for what cannot be seen yet: a
// message being handled, or one a step has just read and that is hidden for a
// moment. Only an empty queue with nothing in flight is a clean start.
async function drain(url: string): Promise<void> {
  await eventually(async () => {
    for (;;) {
      const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
      if (!page.Messages?.length) break;
      await Promise.all(page.Messages.map((message) => sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }))));
    }
    const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    assert.deepEqual([Attributes?.ApproximateNumberOfMessages, Attributes?.ApproximateNumberOfMessagesNotVisible], ["0", "0"], `${url} still holds messages from an earlier scenario`);
  });
}

// Scenarios are independent: each starts with nothing waiting on either queue.
Before(async function () {
  if (receives.length === 0) return;
  await Promise.all([drain(queue()), drain(deadLetterQueue())]);
});

AfterAll(function () {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/messages-delivered.json", JSON.stringify([...delivered].sort(), null, 2) + "\n");
});
