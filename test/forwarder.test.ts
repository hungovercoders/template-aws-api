// The forwarder (src/lib/forwarder.ts), with a bus, a table and a queue for
// what could not be published of the test's own.
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, expect, test, vi } from "vitest";
import type { CloudEvent } from "../src/lib/cloudevents.ts";
import { createForwarder } from "../src/lib/forwarder.ts";
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
  const run = (...records: DynamoDBRecord[]) => handler({ Records: records } as DynamoDBStreamEvent, {} as never, () => {});
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

test("an event the bus will not take is put aside with why, and the ones behind it are still published", async () => {
  quiet();
  let tries = 0;
  const { run, onBus, aside, cleared } = setup(async (given) => {
    if (given.id === "bad") {
      tries++;
      throw new Error("EventBridge refused the event: InternalFailure");
    }
  });
  await run(inserted("e1", event("e1")), inserted("bad", event("bad")), inserted("e3", event("e3")));
  expect(onBus).toEqual(["e1", "e3"]);
  expect(tries).toBe(3);
  expect(aside).toEqual([{ event: event("bad"), reason: "EventBridge refused the event: InternalFailure" }]);
  // Dealt with: it is not left in the outbox to be tried for ever.
  expect(cleared).toEqual(["e1", "bad", "e3"]);
});

test("an outbox item that holds no event is put aside, not published", async () => {
  quiet();
  const { run, onBus, aside, cleared } = setup();
  await run(inserted("empty", undefined));
  expect(onBus).toEqual([]);
  expect(aside).toEqual([{ event: { id: "empty" }, reason: "the outbox item holds no event" }]);
  expect(cleared).toEqual(["empty"]);
});

test("an event that cannot even be put aside fails the batch, so it is offered again and never dropped", async () => {
  quiet();
  const cleared: string[] = [];
  const handler = createForwarder({
    publish: async () => {
      throw new Error("the bus is down");
    },
    setAside: async () => {
      throw new Error("the queue is down");
    },
    clear: async (id) => void cleared.push(id),
  });
  await expect(handler({ Records: [inserted("e1", event("e1"))] } as DynamoDBStreamEvent, {} as never, () => {})).rejects.toThrow("the queue is down");
  expect(cleared).toEqual([]);
});

test("every event is logged once, with what became of it and the trace it belongs to", async () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  vi.spyOn(console, "error").mockImplementation((line: string) => void lines.push(JSON.parse(line)));
  const { run } = setup(async (given) => {
    if (given.id === "bad") throw new Error("refused");
  });
  await run(inserted("e1", event("e1")), inserted("bad", event("bad")));
  expect(lines.map((line) => [line.event_id, line.outcome])).toEqual([
    ["e1", "published"],
    ["bad", "set_aside"],
  ]);
  expect(lines[0]).toMatchObject({ message: "event", event_type: "com.example.catalogue.beer.created.v1", trace_id: "0af7651916cd43dd8448eb211c80319c" });
});
