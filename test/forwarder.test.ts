// The forwarder (src/lib/forwarder.ts), with a bus, a table and a queue for
// what could not be published of the test's own.
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, expect, test, vi } from "vitest";
import type { CloudEvent } from "../src/lib/cloudevents.ts";
import { createForwarder, Unpublishable } from "../src/lib/forwarder.ts";
import { outbox } from "../src/lib/outbox.ts";

afterEach(() => vi.restoreAllMocks());
const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

const event = (id: string): CloudEvent => ({ specversion: "1.0", id, source: "/beer-catalogue", type: "com.example.catalogue.beer.created.v1", time: "2026-01-01T00:00:00Z", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", data: { beer_id: id } });
// A stream record as DynamoDB writes it: typed attributes.
const inserted = (id: string, item: CloudEvent | undefined): DynamoDBRecord => ({
  eventName: "INSERT",
  dynamodb: {
    SequenceNumber: `seq-${id}`,
    Keys: { pk: { S: `outbox#${id}` }, sk: { S: "event" } },
    NewImage: marshall({ pk: `outbox#${id}`, sk: "event", ...(item ? { event: item } : {}) }) as never,
  },
});

function setup(publish: (given: CloudEvent) => Promise<void> = async () => {}) {
  const onBus: string[] = [];
  const aside: { event: unknown; reason: string }[] = [];
  const cleared: string[] = [];
  const handler = createForwarder({
    publish: async (given) => {
      await publish(given);
      onBus.push(given.id);
    },
    setAside: async (given, reason) => void aside.push({ event: given, reason }),
    clear: async (id) => void cleared.push(id),
  });
  const run = (...records: DynamoDBRecord[]) => handler({ Records: records } as DynamoDBStreamEvent);
  return { run, onBus, aside, cleared };
}

test("the write that publishes an event is an outbox item holding it", () => {
  const item = outbox(event("e1"));
  expect(item.Put?.Item).toMatchObject({ pk: "outbox#e1", sk: "event", event: event("e1") });
});

test("each new outbox item is put on the bus, in order, and removed", async () => {
  quiet();
  const { run, onBus, cleared, aside } = setup();
  await run(inserted("e1", event("e1")), inserted("e2", event("e2")));
  expect(onBus).toEqual(["e1", "e2"]);
  expect(cleared).toEqual(["e1", "e2"]);
  expect(aside).toEqual([]);
});

test("anything else that happens to the table is left alone", async () => {
  quiet();
  const { run, onBus, cleared } = setup();
  await run(
    { eventName: "INSERT", dynamodb: { Keys: { pk: { S: "BEER" }, sk: { S: "BEER#1" } } } },
    { eventName: "REMOVE", dynamodb: { Keys: { pk: { S: "outbox#e1" }, sk: { S: "event" } } } },
    { eventName: "MODIFY", dynamodb: { Keys: { pk: { S: "outbox#e1" }, sk: { S: "event" } } } },
  );
  expect(onBus).toEqual([]);
  expect(cleared).toEqual([]);
});

test("an event the bus will never take is put aside with why, and the ones behind it are still published", async () => {
  quiet();
  const { run, onBus, aside, cleared } = setup(async (given) => {
    if (given.id === "bad") throw new Unpublishable("EventBridge refused the event: MalformedDetail");
  });
  expect(await run(inserted("e1", event("e1")), inserted("bad", event("bad")), inserted("e3", event("e3")))).toEqual({ batchItemFailures: [] });
  expect(onBus).toEqual(["e1", "e3"]);
  expect(aside).toEqual([{ event: event("bad"), reason: "EventBridge refused the event: MalformedDetail" }]);
  // Dealt with: it is not left in the outbox to be tried for ever.
  expect(cleared).toEqual(["e1", "bad", "e3"]);
});

test("a failure that may pass stops there: the stream starts again from that event, and nothing is put aside or overtaken", async () => {
  quiet();
  const { run, onBus, aside, cleared } = setup(async (given) => {
    if (given.id === "e2") throw new Error("ThrottlingException");
  });
  expect(await run(inserted("e1", event("e1")), inserted("e2", event("e2")), inserted("e3", event("e3")))).toEqual({ batchItemFailures: [{ itemIdentifier: "seq-e2" }] });
  // e1 is done and is not offered again; e3 waits behind e2.
  expect(onBus).toEqual(["e1"]);
  expect(cleared).toEqual(["e1"]);
  expect(aside).toEqual([]);
});

test("an outbox item that holds no event, or one that cannot be read, is put aside, not published", async () => {
  quiet();
  const { run, onBus, aside, cleared } = setup();
  const unreadable = inserted("huge", undefined);
  unreadable.dynamodb!.NewImage = { pk: { S: "outbox#huge" }, event: { M: { n: { N: "123456789012345678901234567890" } } } } as never;
  await run(inserted("empty", undefined), unreadable);
  expect(onBus).toEqual([]);
  expect(aside[0]).toEqual({ event: { id: "empty" }, reason: "the outbox item holds no event" });
  expect(aside[1]).toMatchObject({ event: { id: "huge" }, reason: expect.stringContaining("cannot be read") });
  expect(cleared).toEqual(["empty", "huge"]);
});

test("an event that cannot be put aside, or removed once published, is offered again and never dropped", async () => {
  quiet();
  const down = async () => {
    throw new Error("down");
  };
  const unpublishable = async () => {
    throw new Unpublishable("too large");
  };
  const aside = createForwarder({ publish: unpublishable, setAside: down, clear: async () => {} });
  expect(await aside({ Records: [inserted("e1", event("e1"))] } as DynamoDBStreamEvent)).toEqual({ batchItemFailures: [{ itemIdentifier: "seq-e1" }] });
  const clearing = createForwarder({ publish: async () => {}, setAside: async () => {}, clear: down });
  expect(await clearing({ Records: [inserted("e1", event("e1"))] } as DynamoDBStreamEvent)).toEqual({ batchItemFailures: [{ itemIdentifier: "seq-e1" }] });
});

test("with too little time left for one more, the forwarder stops and says where to start again", async () => {
  quiet();
  const { onBus } = setup();
  const published: string[] = [];
  let left = 30_000;
  const handler = createForwarder({ publish: async (given) => void published.push(given.id), setAside: async () => {}, clear: async () => {} });
  const answer = await handler({ Records: [inserted("e1", event("e1")), inserted("e2", event("e2"))] } as DynamoDBStreamEvent, { getRemainingTimeInMillis: () => (left -= 11_000) });
  expect(published).toEqual(["e1"]);
  expect(answer).toEqual({ batchItemFailures: [{ itemIdentifier: "seq-e2" }] });
  expect(onBus).toEqual([]);
});

test("every event is logged once, with what became of it and the trace it belongs to", async () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  const { run } = setup(async (given) => {
    if (given.id === "bad") throw new Unpublishable("refused");
    if (given.id === "later") throw new Error("throttled");
  });
  await run(inserted("e1", event("e1")), inserted("bad", event("bad")), inserted("later", event("later")));
  expect(lines.map((line) => [line.event_id, line.outcome])).toEqual([
    ["e1", "published"],
    ["bad", "set_aside"],
    ["later", "retrying"],
  ]);
  expect(lines[0]).toMatchObject({ message: "event", event_type: "com.example.catalogue.beer.created.v1", trace_id: "0af7651916cd43dd8448eb211c80319c" });
});
