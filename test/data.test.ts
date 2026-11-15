// What `task data:generate` writes into the data contract and what
// `task data:check` asks of it (scripts/data.ts).
import { expect, test } from "vitest";
import { parse } from "yaml";
import { generated, needs, read } from "../scripts/data.ts";

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
  const good = "servers:\n  - server: production\n    type: s3\n    location: s3://catalogue-events/events/\n    format: json\n    delimiter: new_line\nslaProperties:\n  - property: retention\n    value: 2\n    unit: y\n  - property: latency\n    value: 15\n    unit: m\n";
  expect(needs(read(good))).toEqual([]);
  expect(needs(read("apiVersion: v3.2.0\n"))).toHaveLength(3);
  expect(needs(read(good.replace("s3://catalogue-events/events/", "s3://catalogue-events/events")))[0]).toContain("s3://<bucket>/<prefix>/");
  expect(needs(read(good.replace("unit: y", "unit: months")))[0]).toContain("retention");
  expect(needs(read(good.replace("value: 15", "value: soon")))[0]).toContain("latency");
});
