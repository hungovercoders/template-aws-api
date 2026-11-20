import { parquetReadObjects } from "hyparquet";
import { expect, test } from "vitest";
import { layout } from "../scripts/data.ts";
import { compact, dayOf, parquetSchema, type SchemaObject, Unplaceable, valueOf, window } from "../src/lib/compactor.ts";

const QUOTE: SchemaObject = {
  name: "quote_created_v1",
  physicalName: "com.example.motor_quote.quote.created.v1",
  properties: [
    { name: "id", logicalType: "string", required: true },
    { name: "type", logicalType: "string", required: true },
    { name: "time", logicalType: "timestamp", required: true },
    { name: "subject", logicalType: "string" },
    {
      name: "data",
      logicalType: "object",
      required: true,
      properties: [
        { name: "quote_id", logicalType: "string", required: true },
        { name: "premium", logicalType: "number", required: true },
        { name: "driver_age", logicalType: "integer", required: true },
        { name: "accepted", logicalType: "boolean" },
        { name: "tags", logicalType: "array", items: { logicalType: "string" } },
      ],
    },
  ],
};
const event = (id: string, time: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ specversion: "1.0", id, source: "/api", type: QUOTE.physicalName, time, data: { quote_id: `q-${id}`, premium: 425.6, driver_age: 30, ...data } });
const read = async (bytes: Uint8Array) => parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });

test("the Parquet schema is the contract's: a column per property, nested as it nests them", () => {
  expect(parquetSchema(QUOTE.properties)).toEqual([
    { name: "root", num_children: 5 },
    { name: "id", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" },
    { name: "type", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" },
    { name: "time", type: "INT64", converted_type: "TIMESTAMP_MILLIS", repetition_type: "REQUIRED" },
    { name: "subject", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "OPTIONAL" },
    { name: "data", repetition_type: "REQUIRED", num_children: 5 },
    { name: "quote_id", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" },
    { name: "premium", type: "DOUBLE", repetition_type: "REQUIRED" },
    { name: "driver_age", type: "INT64", repetition_type: "REQUIRED" },
    { name: "accepted", type: "BOOLEAN", repetition_type: "OPTIONAL" },
    { name: "tags", repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "OPTIONAL" },
  ]);
});

test("a value is held as its column types it, or the event is not placed", () => {
  expect(valueOf({ name: "n", logicalType: "integer" }, 30)).toBe(30n);
  expect(valueOf({ name: "d", logicalType: "date" }, "2026-11-20")).toBe(Date.UTC(2026, 10, 20) / 86_400_000);
  expect(valueOf({ name: "t", logicalType: "timestamp" }, "2026-11-20T10:00:00+01:00")).toEqual(new Date("2026-11-20T09:00:00Z"));
  expect(valueOf({ name: "o", logicalType: "object" }, { a: 1 })).toBe('{"a":1}');
  expect(valueOf({ name: "s" }, null)).toBeNull();
  for (const [property, value] of [
    [{ name: "n", logicalType: "integer" }, 1.5],
    [{ name: "n", logicalType: "number" }, "1"],
    [{ name: "s", logicalType: "string", required: true }, undefined],
    [{ name: "t", logicalType: "timestamp" }, "yesterday"],
  ] as const) {
    expect(() => valueOf(property, value)).toThrow(Unplaceable);
  }
});

test("each event is written once, on the day it happened, in time order", async () => {
  const lines = [
    event("b", "2026-11-19T23:59:00Z"),
    event("a", "2026-11-19T08:00:00Z", { tags: ["young", "driver"], accepted: true }),
    event("a", "2026-11-19T08:00:00Z"), // delivered twice
    "",
    event("c", "2026-11-20T00:01:00Z"),
  ];
  const { files, rejected } = compact(QUOTE, lines);
  expect(rejected).toEqual([]);
  expect(files.map(({ day, events }) => [day, events])).toEqual([
    ["2026-11-19", 2],
    ["2026-11-20", 1],
  ]);
  const rows = await read(files[0]!.parquet);
  expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(rows[0]).toMatchObject({ type: QUOTE.physicalName, subject: null, data: { quote_id: "q-a", premium: 425.6, driver_age: 30n, accepted: true, tags: ["young", "driver"] } });
  expect(rows[0]!.time).toEqual(new Date("2026-11-19T08:00:00Z"));
});

test("the same lines make the same file, and only the days asked for are written", () => {
  const lines = [event("a", "2026-11-19T08:00:00Z"), event("b", "2026-11-20T08:00:00Z")];
  const once = compact(QUOTE, lines).files;
  const again = compact(QUOTE, [...lines].reverse()).files;
  expect(again.map((file) => Buffer.from(file.parquet).toString("hex"))).toEqual(once.map((file) => Buffer.from(file.parquet).toString("hex")));
  expect(compact(QUOTE, lines, new Set(["2026-11-20"])).files.map((file) => file.day)).toEqual(["2026-11-20"]);
});

test("what cannot be placed is said, and the rest of the day is still written", () => {
  const { files, rejected } = compact(QUOTE, [event("a", "2026-11-19T08:00:00Z", { premium: "lots" }), "not json", event("b", "2026-11-19T09:00:00Z"), JSON.stringify({ id: "c" })]);
  expect(rejected).toEqual([
    { id: "?", reason: "a line that is not JSON" },
    { id: "a", reason: 'premium is not a number: "lots"' },
    { id: "c", reason: "an event with no time" },
  ]);
  expect(files.map(({ day, events }) => [day, events])).toEqual([["2026-11-19", 1]]);
});

test("a run rewrites the last whole days, and today when asked", () => {
  const now = new Date("2026-11-20T00:17:00Z");
  expect(window(now, 3, false)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
  expect(window(now, 1, true)).toEqual(["2026-11-19", "2026-11-20"]);
  expect(dayOf({ time: "2026-11-20T00:30:00+01:00" })).toBe("2026-11-19");
});

test("the compactor's layout is each major's schema objects, as the contract types them", () => {
  const contract = [
    "apiVersion: v3.2.0",
    "schema:",
    "  - name: quote_created_v1",
    "    physicalName: com.example.motor_quote.quote.created.v1",
    "    description: words the compactor does not need",
    "    properties:",
    "      - name: data",
    "        logicalType: object",
    "        required: true",
    "        classification: confidential",
    "        properties:",
    "          - name: premium",
    "            logicalType: number",
    "  - name: undescribed",
  ].join("\n");
  expect(layout({ v0: contract })).toEqual({
    v0: [{ name: "quote_created_v1", physicalName: "com.example.motor_quote.quote.created.v1", properties: [{ name: "data", logicalType: "object", required: true, properties: [{ name: "premium", logicalType: "number" }] }] }],
  });
});
