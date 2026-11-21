// The queue consumer (src/lib/consumer.ts), with a contract, a table of
// claims and a dead-letter queue of the test's own.
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { afterEach, expect, test, vi } from "vitest";
import { type CloudEvent, InvalidEvent } from "../src/lib/cloudevents.ts";
import { type Claims, type Consumers, createConsumer, Rejected } from "../src/lib/consumer.ts";
import { traceId } from "../src/lib/trace.ts";

afterEach(() => vi.restoreAllMocks());

const TYPE = "com.example.catalogue.beer.rated.v1";
const event = (id: string, extra: Partial<CloudEvent> = {}): CloudEvent => ({ specversion: "1.0", id, source: "/taproom", type: TYPE, time: "2026-01-01T00:00:00Z", data: { score: 5 }, ...extra });
const record = (id: string, body: unknown): SQSRecord => ({ messageId: id, body: typeof body === "string" ? body : JSON.stringify(body), attributes: { ApproximateReceiveCount: "1" } }) as SQSRecord;

// Claims as the table keeps them, in memory.
function memoryClaims() {
  const state = new Map<string, "handling" | "done">();
  const claims: Claims = {
    claim: async (key) => (state.get(key) === "done" ? "done" : state.get(key) === "handling" ? "busy" : (state.set(key, "handling"), "claimed")),
    complete: async (key) => void state.set(key, "done"),
    release: async (key) => void state.delete(key),
  };
  return { claims, state };
}

function setup(handle: (event: CloudEvent) => Promise<void> | void = () => {}) {
  const handled: CloudEvent[] = [];
  const deadLettered: { id: string; reason: string }[] = [];
  const memory = memoryClaims();
  const consumers: Consumers = {
    record_rating: async ({ event }) => {
      await handle(event);
      handled.push(event);
    },
  };
  const handler = createConsumer(consumers, {
    parse: (body) => {
      let parsed: CloudEvent;
      try {
        parsed = JSON.parse(body) as CloudEvent;
      } catch {
        throw new InvalidEvent("the message is not JSON");
      }
      if (parsed.type !== TYPE && parsed.type !== "com.example.catalogue.beer.unhandled.v1") throw new InvalidEvent(`"${parsed.type}" is not a message this API's contract says it accepts`);
      return parsed;
    },
    operationFor: (type) => (type === TYPE ? "record_rating" : type.includes("unhandled") ? "nobody_home" : undefined),
    claims: memory.claims,
    deadLetter: async (given, reason) => void deadLettered.push({ id: given.messageId, reason }),
  });
  const run = async (...records: SQSRecord[]) => ((await handler({ Records: records } as SQSEvent, {} as never, () => {})) as SQSBatchResponse).batchItemFailures.map((failure) => failure.itemIdentifier);
  return { run, handled, deadLettered, ...memory };
}
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

test("a message is handed to its operation and accepted", async () => {
  quiet();
  const { run, handled, state } = setup();
  expect(await run(record("m1", event("e1")))).toEqual([]);
  expect(handled.map((given) => given.id)).toEqual(["e1"]);
  expect(state.get("/taproom#e1")).toBe("done");
});

test("a message delivered twice takes effect once", async () => {
  quiet();
  const { run, handled } = setup();
  expect(await run(record("m1", event("e1")))).toEqual([]);
  // Again, as SQS may: another message id, the same event.
  expect(await run(record("m2", event("e1")))).toEqual([]);
  expect(await run(record("m3", event("e1")), record("m4", event("e2")))).toEqual([]);
  expect(handled.map((given) => given.id)).toEqual(["e1", "e2"]);
  // The same id from another source is another event.
  expect(await run(record("m5", event("e1", { source: "/festival" })))).toEqual([]);
  expect(handled).toHaveLength(3);
});

test("one message that fails does not fail the batch it came in, and is offered again", async () => {
  quiet();
  let attempts = 0;
  const { run, handled, state } = setup((given) => {
    if (given.id === "bad" && attempts++ === 0) throw new Error("the table was busy");
  });
  expect(await run(record("m1", event("e1")), record("m2", event("bad")), record("m3", event("e3")))).toEqual(["m2"]);
  expect(handled.map((given) => given.id)).toEqual(["e1", "e3"]);
  // The claim was given up, so the next delivery can try - and this time succeeds.
  expect(state.has("/taproom#bad")).toBe(false);
  expect(await run(record("m2", event("bad")))).toEqual([]);
  expect(handled.map((given) => given.id)).toEqual(["e1", "e3", "bad"]);
});

test("a message that can never succeed is put aside at once, with why, and not offered again", async () => {
  quiet();
  const { run, handled, deadLettered } = setup();
  expect(await run(record("m1", "not json"), record("m2", event("e2", { type: "com.example.other.thing.happened.v1" })), record("m3", event("e3")))).toEqual([]);
  expect(deadLettered).toEqual([
    { id: "m1", reason: "the message is not JSON" },
    { id: "m2", reason: '"com.example.other.thing.happened.v1" is not a message this API\'s contract says it accepts' },
  ]);
  expect(handled.map((given) => given.id)).toEqual(["e3"]);
});

test("a message its operation rejects is put aside at once, and tried again if it comes back", async () => {
  quiet();
  let exists = false;
  const { run, deadLettered, handled, state } = setup(() => {
    if (!exists) throw new Rejected("there is no such beer");
  });
  expect(await run(record("m1", event("e1")))).toEqual([]);
  expect(deadLettered).toEqual([{ id: "m1", reason: "there is no such beer" }]);
  expect(state.has("/taproom#e1")).toBe(false);
  // Redriven after what it named was added: it is handled, not skipped as a duplicate.
  exists = true;
  expect(await run(record("m2", event("e1")))).toEqual([]);
  expect(handled.map((given) => given.id)).toEqual(["e1"]);
});

test("a type the contract accepts but nothing handles is put aside, loudly", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { run, deadLettered } = setup();
  expect(await run(record("m1", event("e1", { type: "com.example.catalogue.beer.unhandled.v1" })))).toEqual([]);
  expect(deadLettered).toEqual([{ id: "m1", reason: "no consumer for com.example.catalogue.beer.unhandled.v1" }]);
  expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({ SeverityText: "ERROR", Attributes: { outcome: "dead_lettered" } });
});

test("a message another delivery is still handling is offered again later", async () => {
  quiet();
  const { run, state, handled } = setup();
  state.set("/taproom#e1", "handling");
  expect(await run(record("m1", event("e1")))).toEqual(["m1"]);
  expect(handled).toEqual([]);
});

test("a message that took effect is not offered again when recording that fails", async () => {
  quiet();
  const { run, handled, claims } = setup();
  claims.complete = async () => {
    throw new Error("the table was busy");
  };
  expect(await run(record("m1", event("e1")))).toEqual([]);
  expect(handled.map((given) => given.id)).toEqual(["e1"]);
});

test("on a FIFO queue nothing after a failed message is handled before it is tried again", async () => {
  quiet();
  const { run, handled } = setup((given) => {
    if (given.id === "bad") throw new Error("boom");
  });
  const inGroup = (id: string, body: unknown) => ({ ...record(id, body), attributes: { ApproximateReceiveCount: "1", MessageGroupId: "g" } }) as SQSRecord;
  expect(await run(inGroup("m1", event("e1")), inGroup("m2", event("bad")), inGroup("m3", event("e3")))).toEqual(["m2", "m3"]);
  expect(handled.map((given) => given.id)).toEqual(["e1"]);
});

test("every message is logged once, with what it was and what became of it", async () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  const { run } = setup((given) => {
    if (given.id === "bad") throw new Error("boom");
  });
  await run(record("m1", event("e1")), record("m2", event("bad")), record("m3", event("e1")));
  const attributes = lines.map((line) => line.Attributes as Record<string, unknown>);
  expect(attributes.map((line) => [line.message_id, line.outcome])).toEqual([
    ["m1", "handled"],
    ["m2", "failed"],
    ["m3", "duplicate"],
  ]);
  expect(lines[0]).toMatchObject({ SeverityText: "INFO", Body: "message", TraceId: traceId(), Attributes: { event_id: "e1", event_type: TYPE, operation_id: "record_rating", receive_count: 1 } });
  expect((attributes[1]!.error as { message: string }).message).toBe("boom");
});
