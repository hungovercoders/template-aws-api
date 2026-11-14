// The CloudEvents envelope (src/lib/cloudevents.ts) and the trace context it
// carries (src/lib/trace.ts), against a contract of the test's own.
import { expect, test } from "vitest";
import { type CloudEvent, InvalidEvent, eventsOf } from "../src/lib/cloudevents.ts";
import { continueTrace, traceId, traceparent } from "../src/lib/trace.ts";

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
const TYPE = "com.example.beer_catalogue.beer.created.v1";
const document = {
  components: {
    messages: {
      beer_created: {
        name: "beer_created",
        payload: {
          allOf: [
            envelope,
            {
              type: "object",
              required: ["data"],
              properties: {
                type: { type: "string", const: TYPE },
                data: { type: "object", required: ["beer_id", "abv"], additionalProperties: false, properties: { beer_id: { type: "string" }, abv: { type: "number", minimum: 0 } } },
              },
            },
          ],
        },
      },
    },
  },
};
type BeerCreated = CloudEvent<typeof TYPE, { beer_id: string; abv: number }>;
const events = eventsOf(document, () => "/beer-catalogue");

test("an event to publish gets its envelope from the skeleton", () => {
  continueTrace("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  const event = events.create<BeerCreated>(TYPE, { beer_id: "b1", abv: 5.2 }, "b1");
  expect(event).toMatchObject({ specversion: "1.0", source: "/beer-catalogue", type: TYPE, subject: "b1", datacontenttype: "application/json", data: { beer_id: "b1", abv: 5.2 } });
  expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(Number.isNaN(Date.parse(event.time))).toBe(false);
  // The trace of the request that caused it, with a span of this API's own.
  expect(event.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
  expect(event.traceparent).not.toContain("b7ad6b7169203331");
  expect(events.create<BeerCreated>(TYPE, { beer_id: "b2", abv: 4 }).id).not.toBe(event.id);
});

test("an event that does not match the contract cannot be created", () => {
  expect(() => events.create<BeerCreated>(TYPE, { beer_id: "b1", abv: -1 })).toThrow(/does not match specs\/asyncapi.yaml: \/data\/abv must be >= 0/);
  expect(() => events.create<BeerCreated>(TYPE, { beer_id: "b1" } as never)).toThrow(/must have required property 'abv'/);
  expect(() => events.create("com.example.beer.exploded.v1", {})).toThrow(/is not an event in specs\/asyncapi.yaml/);
});

test("a message received is the CloudEvent the contract describes, or it is refused", () => {
  const good = events.create<BeerCreated>(TYPE, { beer_id: "b1", abv: 5.2 });
  expect(events.parse(JSON.stringify(good))).toEqual(good);
  expect(events.parse(good)).toEqual(good);

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
  expect(refused({ ...good, type: "com.example.other.happened.v1" }).reason).toContain("is not a type this API's contract describes");
  expect(refused({ ...good, data: { beer_id: "b1", abv: 5.2, extra: true } }).violations).toEqual([{ pointer: "/data", message: "must NOT have additional properties" }]);
  const { id: _, ...noId } = good;
  expect(refused(noId).violations[0]).toEqual({ pointer: "", message: "must have required property 'id'" });
  expect(refused({ ...good, specversion: "0.3" }).violations[0]!.pointer).toBe("/specversion");
});

test("a trace carries on from a well formed traceparent and starts anew otherwise", () => {
  const carried = continueTrace("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00");
  expect(carried).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-00$/);
  expect(traceparent()).toBe(carried);
  expect(traceId()).toBe("0af7651916cd43dd8448eb211c80319c");
  for (const incoming of [undefined, "", "garbage", "00-00000000000000000000000000000000-b7ad6b7169203331-01", "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"]) {
    const fresh = continueTrace(incoming);
    expect(fresh).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(fresh).not.toContain("0af7651916cd43dd8448eb211c80319c");
  }
});
