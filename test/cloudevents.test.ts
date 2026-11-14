// The CloudEvents envelope (src/lib/cloudevents.ts), against a contract of
// the test's own: one event the API publishes, one message it accepts.
import { expect, test } from "vitest";
import { type CloudEvent, InvalidEvent, eventsOf } from "../src/lib/cloudevents.ts";
import { continueTrace, traceId } from "../src/lib/trace.ts";

const envelope = {
  type: "object",
  required: ["specversion", "id", "source", "type", "time"],
  properties: {
    specversion: { type: "string", const: "1.0" },
    id: { type: "string", minLength: 1 },
    source: { type: "string", format: "uri-reference", minLength: 1 },
    type: { type: "string", minLength: 1 },
    time: { type: "string", format: "date-time" },
    subject: { type: "string" },
    traceparent: { type: "string", pattern: "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$" },
  },
};
const message = (type: string, data: object) => ({ payload: { allOf: [envelope, { type: "object", required: ["data"], properties: { type: { type: "string", const: type }, data } }] } });
const CREATED = "com.example.beer_catalogue.beer.created.v1";
const CLOSED = "com.example.brewery_registry.brewery.closed.v1";
const document = {
  operations: {
    publish_beer_created: {
      action: "send",
      messages: [message(CREATED, { type: "object", required: ["beer_id", "abv"], additionalProperties: false, properties: { beer_id: { type: "string" }, abv: { type: "number", minimum: 0 } } })],
    },
    handle_brewery_closed: {
      action: "receive",
      messages: [message(CLOSED, { type: "object", required: ["brewery_id"], additionalProperties: false, properties: { brewery_id: { type: "string" } } })],
    },
  },
};
type BeerCreated = CloudEvent<typeof CREATED, { beer_id: string; abv: number }>;
// As `task generate` writes it; the test spells out only what the runtime reads.
const events = eventsOf(document as never, () => "/beer-catalogue");
const TRACE = "0af7651916cd43dd8448eb211c80319c";
const closed = (extra: object = {}) => ({ specversion: "1.0", id: "e1", source: "/brewery-registry", type: CLOSED, time: "2026-01-01T00:00:00Z", data: { brewery_id: "br1" }, ...extra });

test("the contract says which types are published and which are accepted", () => {
  expect(events.publishes).toEqual([CREATED]);
  expect(events.accepts).toEqual([CLOSED]);
});

test("an event to publish gets its envelope from the skeleton", () => {
  continueTrace(`00-${TRACE}-b7ad6b7169203331-01`);
  const event = events.create<BeerCreated>(CREATED, { beer_id: "b1", abv: 5.2 }, "b1");
  expect(event).toMatchObject({ specversion: "1.0", source: "/beer-catalogue", type: CREATED, subject: "b1", datacontenttype: "application/json", data: { beer_id: "b1", abv: 5.2 } });
  expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Number.isNaN(Date.parse(event.time))).toBe(false);
  // The trace of the request that caused it.
  expect(event.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
  expect(events.create<BeerCreated>(CREATED, { beer_id: "b2", abv: 4 }).id).not.toBe(event.id);
});

test("an event that does not match the contract cannot be created", () => {
  expect(() => events.create<BeerCreated>(CREATED, { beer_id: "b1", abv: -1 })).toThrow(/does not match specs\/asyncapi.yaml: \/data\/abv must be >= 0/);
  expect(() => events.create<BeerCreated>(CREATED, { beer_id: "b1" } as never)).toThrow(/must have required property 'abv'/);
  expect(() => events.create("com.example.beer_catalogue.beer.exploded.v1", {})).toThrow(/is not an event specs\/asyncapi.yaml says this API publishes/);
  // A message this API accepts is not one it may publish.
  expect(() => events.create(CLOSED, { brewery_id: "br1" })).toThrow(/is not an event specs\/asyncapi.yaml says this API publishes/);
});

test("a message received is the CloudEvent the contract describes, or it is refused", () => {
  expect(events.parse(JSON.stringify(closed()))).toEqual(closed());
  expect(events.parse(closed())).toEqual(closed());

  const refused = (message: unknown) => {
    try {
      events.parse(message);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEvent);
      return error as InvalidEvent;
    }
    throw new Error("the message was accepted");
  };
  expect(refused("not json").reason).toBe("the message is not JSON");
  expect(refused({ hello: "world" }).reason).toContain("it has no type");
  expect(refused({ ...closed(), type: "com.example.other.thing.happened.v1" }).reason).toContain("is not a message this API's contract says it accepts");
  // An event this API publishes is not one it accepts.
  expect(refused(events.create<BeerCreated>(CREATED, { beer_id: "b1", abv: 5 })).reason).toContain("is not a message this API's contract says it accepts");
  expect(refused(closed({ data: { brewery_id: "br1", extra: true } })).violations).toEqual([{ pointer: "/data", message: "must NOT have additional properties" }]);
  const { id: _, ...noId } = closed();
  expect(refused(noId).violations[0]).toEqual({ pointer: "", message: "must have required property 'id'" });
  expect(refused(closed({ specversion: "0.3" })).violations[0]!.pointer).toBe("/specversion");
});

test("handling a message carries its trace on, and a refused one does not", () => {
  continueTrace();
  events.parse(closed({ traceparent: `00-${TRACE}-b7ad6b7169203331-01` }));
  expect(traceId()).toBe(TRACE);
  // What handling it publishes belongs to the same trace.
  expect(events.create<BeerCreated>(CREATED, { beer_id: "b1", abv: 5 }).traceparent).toContain(TRACE);

  const before = continueTrace();
  expect(() => events.parse({ ...closed({ traceparent: `00-${TRACE}-b7ad6b7169203331-01` }), data: {} })).toThrow(InvalidEvent);
  expect(traceId()).toBe(before.split("-")[1]);
  // A message with no trace of its own starts one.
  events.parse(closed());
  expect(traceId()).not.toBe(before.split("-")[1]);
});
