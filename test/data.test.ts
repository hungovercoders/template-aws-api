// What `task data:generate` writes into the data contract and what
// `task data:check` asks of it (scripts/data.ts).
import { expect, test } from "vitest";
import { parse } from "yaml";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generated, needs, published, read } from "../scripts/data.ts";

const rated = {
  name: "beer_rated",
  type: "com.example.catalogue.beer.rated.v1",
  title: "Beer rated",
  summary: "A drinker scored a beer.",
  properties: [
    { name: "id", logicalType: "string", required: true, options: { minLength: 1 }, description: "Identifies the event." },
    { name: "time", logicalType: "timestamp", required: true },
    { name: "subject", logicalType: "string", required: false },
    {
      name: "data",
      logicalType: "object",
      required: true,
      properties: [
        { name: "score", logicalType: "integer", required: true, options: { minimum: 1, maximum: 5 } },
        { name: "tags", logicalType: "array", required: false, items: { name: "items", logicalType: "string", required: false } },
      ],
    },
  ],
};

test("an event is written as a schema object: where it lands, and each property's type and whether it is required", () => {
  const { text, strays } = generated("apiVersion: v3.2.0\nkind: DataContract\n", [rated]);
  expect(strays).toEqual([]);
  expect(parse(text).schema).toEqual([
    {
      name: "beer_rated",
      physicalName: "com.example.catalogue.beer.rated.v1",
      physicalType: "object",
      businessName: "Beer rated",
      description: "A drinker scored a beer.",
      properties: [
        { name: "id", logicalType: "string", required: true, logicalTypeOptions: { minLength: 1 }, description: "Identifies the event." },
        { name: "time", logicalType: "timestamp", required: true },
        { name: "subject", logicalType: "string" },
        {
          name: "data",
          logicalType: "object",
          required: true,
          properties: [
            { name: "score", logicalType: "integer", required: true, logicalTypeOptions: { minimum: 1, maximum: 5 } },
            { name: "tags", logicalType: "array", items: { logicalType: "string" } },
          ],
        },
      ],
    },
  ]);
});

test("writing it again changes nothing, so the gate can compare", () => {
  const once = generated("apiVersion: v3.2.0\n", [rated]).text;
  expect(generated(once, [rated]).text).toBe(once);
});

test("what a person wrote is kept, and what the AsyncAPI contract decides is put right", () => {
  const written = [
    "apiVersion: v3.2.0",
    "# who to ask",
    "team:",
    "  name: catalogue",
    "schema:",
    "  - name: beer_rated",
    "    description: Every score a drinker gave.",
    "    quality:",
    "      - metric: rowCount",
    "        mustBeGreaterThan: 0",
    "    properties:",
    "      - name: id",
    "        classification: public",
    "        logicalType: integer",
    "        description: The event's own id.",
    "      - name: subject",
    "        classification: internal",
    "        required: true",
    "",
  ].join("\n");
  const { text } = generated(written, [rated]);
  expect(text).toContain("# who to ask");
  const object = parse(text).schema[0];
  expect(object.description).toBe("Every score a drinker gave.");
  expect(object.quality).toEqual([{ metric: "rowCount", mustBeGreaterThan: 0 }]);
  expect(object.properties[0]).toMatchObject({ name: "id", classification: "public", logicalType: "string", required: true, description: "The event's own id." });
  // No longer required in the AsyncAPI contract, so no longer here.
  expect(object.properties[1]).toEqual({ name: "subject", classification: "internal", logicalType: "string" });
  expect(object.properties.map((property: { name: string }) => property.name)).toEqual(["id", "subject", "time", "data"]);
});

test("an event or a property the AsyncAPI contract does not have is named, not removed", () => {
  const written = "schema:\n  - name: beer_rated\n    properties:\n      - name: mood\n        logicalType: string\n  - name: beer_brewed\n";
  const { text, strays } = generated(written, [rated]);
  expect(strays).toEqual(["beer_rated.mood is not a property of the event in the AsyncAPI contract", "beer_brewed is not an event the AsyncAPI contract says the API publishes"]);
  expect(text).toContain("mood");
  expect(text).toContain("beer_brewed");
});

test("the contract must say where the data is kept, for how long and how fresh, in the form the infrastructure reads", () => {
  const good =
    "servers:\n  - server: production\n    type: s3\n    location: s3://catalogue-events/events/\n    format: json\n    delimiter: new_line\n" +
    "  - server: production-parquet\n    type: s3\n    location: s3://catalogue-events/parquet/\n    format: parquet\n" +
    "slaProperties:\n  - property: retention\n    value: 2\n    unit: y\n  - property: latency\n    value: 15\n    unit: m\n";
  expect(needs(read(good))).toEqual([]);
  expect(needs(read("apiVersion: v3.2.0\n"))).toHaveLength(3);
  expect(needs(read(good.replace("s3://catalogue-events/events/", "s3://catalogue-events/events")))[0]).toContain("s3://<bucket>/<prefix>/");
  expect(needs(read(good.replace("unit: y", "unit: months")))[0]).toContain("retention");
  expect(needs(read(good.replace("value: 15", "value: soon")))[0]).toContain("latency");
});

test("beside every raw server is its Parquet, in the same bucket and a prefix of its own", () => {
  const sla = "slaProperties:\n  - property: retention\n    value: 30\n    unit: d\n  - property: latency\n    value: 1\n    unit: h\n";
  const raw = "servers:\n  - server: production\n    type: s3\n    location: s3://catalogue-events/events/v1/\n    format: json\n    delimiter: new_line\n";
  const parquet = (location: string, format = "parquet") => `  - server: production-parquet\n    type: s3\n    location: ${location}\n    format: ${format}\n`;
  expect(needs(read(`${raw}${parquet("s3://catalogue-events/parquet/v1/")}${sla}`))).toEqual([]);
  expect(needs(read(`${raw}${sla}`))).toEqual([expect.stringContaining("has no production-parquet server beside it")]);
  expect(needs(read(`${raw}${parquet("s3://other-bucket/parquet/v1/")}${sla}`))).toEqual([expect.stringContaining("is in bucket other-bucket, not catalogue-events")]);
  expect(needs(read(`${raw}${parquet("s3://catalogue-events/events/v1/parquet/")}${sla}`))).toEqual([expect.stringContaining("prefix overlaps")]);
  expect(needs(read(`${raw}${parquet("s3://catalogue-events/parquet/v1/", "json")}${sla}`))).toEqual([expect.stringContaining("must say format: parquet")]);
});

test("every server is held to the form the infrastructure reads, not only production", () => {
  const server = (name: string, location: string) =>
    `  - server: ${name}\n    type: s3\n    location: ${location}\n    format: json\n    delimiter: new_line\n` +
    `  - server: ${name}-parquet\n    type: s3\n    location: ${location.replace("/events", "/parquet")}\n    format: parquet\n`;
  const sla = "slaProperties:\n  - property: retention\n    value: 30\n    unit: d\n  - property: latency\n    value: 1\n    unit: h\n";
  expect(needs(read(`servers:\n${server("production", "s3://catalogue-events/events/")}${server("test", "s3://catalogue-events-test/events/")}${sla}`))).toEqual([]);
  expect(needs(read(`servers:\n${server("production", "s3://catalogue-events/events/")}${server("test", "s3://catalogue-events-test")}${sla}`))).toEqual([
    expect.stringContaining("the test server's location"),
    expect.stringContaining("the test-parquet server's location"),
  ]);
});

test("what is read from the AsyncAPI contract: only published events, a nullable property is not required, and limits only where the type has them", () => {
  const envelope = { type: "object", required: ["id", "time"], properties: { id: { type: "string", minLength: 1 }, time: { type: "string", format: "date-time", maxLength: 40 } } };
  const payload = (type: string, data: object) => ({ allOf: [envelope, { type: "object", required: ["data"], properties: { type: { type: "string", const: type }, data } }] });
  const file = join(mkdtempSync(join(tmpdir(), "data-test-")), "asyncapi.json");
  writeFileSync(
    file,
    JSON.stringify({
      operations: {
        publish_rated: {
          action: "send",
          messages: [
            {
              name: "beer_rated",
              title: "Beer rated",
              payload: payload("com.example.beer.rated.v1", {
                type: "object",
                required: ["score", "note"],
                properties: { score: { type: "integer", minimum: 1, maximum: 5 }, note: { type: ["string", "null"], maxLength: 200 }, at: { type: "string", format: "date" } },
              }),
            },
          ],
        },
        receive_rating: { action: "receive", messages: [{ name: "rating_submitted", payload: payload("com.example.rating.submitted.v1", { type: "object" }) }] },
      },
    }),
  );
  const events = published(file);
  expect(events.map((event) => [event.name, event.type])).toEqual([["beer_rated", "com.example.beer.rated.v1"]]);
  const byName = Object.fromEntries(events[0]!.properties.map((property) => [property.name, property]));
  expect(byName.id).toMatchObject({ logicalType: "string", required: true, options: { minLength: 1 } });
  // A timestamp has no length in ODCS.
  expect(byName.time).toEqual({ name: "time", logicalType: "timestamp", required: true, description: undefined });
  expect(byName.data!.properties).toEqual([
    { name: "score", logicalType: "integer", required: true, description: undefined, options: { minimum: 1, maximum: 5 } },
    { name: "note", logicalType: "string", required: false, description: undefined, options: { maxLength: 200 } },
    { name: "at", logicalType: "date", required: false, description: undefined },
  ]);
});
