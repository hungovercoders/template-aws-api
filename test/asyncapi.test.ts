// The gates and generators of the AsyncAPI contract (tools/asyncapi), run
// against a contract of the test's own in a temporary repository.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { changes } from "../tools/asyncapi/asyncapi.ts";

const CONTRACT = `
asyncapi: 3.1.0
info:
  title: Beer Catalogue Events
  version: 1.0.0
  description: The messages the Beer Catalogue receives and the events it publishes.
channels:
  brewery_notices:
    address: brewery-notices
    messages:
      brewery_closed:
        $ref: '#/components/messages/brewery_closed'
  beer_events:
    address: beer-events
    messages:
      beer_created:
        $ref: '#/components/messages/beer_created'
operations:
  handle_brewery_closed:
    action: receive
    summary: Retire the beers of a brewery that closed.
    channel:
      $ref: '#/channels/brewery_notices'
    messages:
      - $ref: '#/channels/brewery_notices/messages/brewery_closed'
  publish_beer_created:
    action: send
    summary: A beer was added to the catalogue.
    channel:
      $ref: '#/channels/beer_events'
    messages:
      - $ref: '#/channels/beer_events/messages/beer_created'
components:
  messages:
    brewery_closed:
      name: brewery_closed
      summary: A brewery stopped trading.
      contentType: application/cloudevents+json
      payload:
        $ref: '#/components/schemas/BreweryClosedEvent'
    beer_created:
      name: beer_created
      summary: A beer was added.
      contentType: application/cloudevents+json
      payload:
        $ref: '#/components/schemas/BeerCreatedEvent'
  schemas:
    BreweryClosedEvent:
      allOf:
        - $ref: '../tools/asyncapi/cloudevent.yaml#/CloudEvent'
        - type: object
          required: [data]
          properties:
            type: { type: string, const: com.example.registry.brewery.closed.v1 }
            data:
              type: object
              required: [brewery_id]
              additionalProperties: false
              properties:
                brewery_id: { type: string }
    BeerCreatedEvent:
      allOf:
        - $ref: '../tools/asyncapi/cloudevent.yaml#/CloudEvent'
        - type: object
          required: [data]
          properties:
            type: { type: string, const: com.example.catalogue.beer.created.v1 }
            data:
              type: object
              required: [beer_id, name, abv]
              additionalProperties: false
              properties:
                beer_id: { type: string }
                name: { type: string, minLength: 1 }
                abv: { type: number, minimum: 0 }
                style: { type: string }
`;
const FEATURE = ["@operation:handle_brewery_closed", "Feature: Events", "  Scenario: a brewery closes", "    Given a brewery", "  @operation:publish_beer_created", "  Scenario: a beer is created", "    Given a beer", ""].join("\n");

type Document = Record<string, any>;
const base = parse(CONTRACT) as Document;
const edited = (edit: (document: Document) => void) => {
  const document = structuredClone(base);
  edit(document);
  return document;
};
const data = (document: Document) => document.components.schemas.BeerCreatedEvent.allOf[1].properties.data;

// --- What counts as breaking -------------------------------------------------
const verdict = (after: Document) => {
  const found = changes(base, after).filter((change) => change.path !== "/info/version");
  return found.some((change) => change.level === "breaking") ? "breaking" : found.some((change) => change.level === "unclassified") ? "unclassified" : found.length > 0 ? "non-breaking" : "none";
};
test.each<[string, string, (document: Document) => void]>([
  ["an optional property added", "non-breaking", (d) => (data(d).properties.brewery_id = { type: "string" })],
  ["a new event added", "non-breaking", (d) => {
    d.components.messages.beer_retired = { name: "beer_retired", payload: { type: "object" } };
    d.channels.beer_events.messages.beer_retired = { $ref: "#/components/messages/beer_retired" };
  }],
  ["a summary reworded", "non-breaking", (d) => (d.components.messages.beer_created.summary = "A beer joined the catalogue.")],
  ["a description added to a property", "non-breaking", (d) => (data(d).properties.abv.description = "Alcohol by volume")],
  ["only the version changed", "none", (d) => (d.info.version = "1.1.0")],
  ["a property removed", "breaking", (d) => {
    delete data(d).properties.abv;
    data(d).required = ["beer_id", "name"];
  }],
  ["a property made required", "breaking", (d) => data(d).required.push("style")],
  ["a property's type changed", "breaking", (d) => (data(d).properties.abv.type = "string")],
  ["an event's type renamed", "breaking", (d) => (d.components.schemas.BeerCreatedEvent.allOf[1].properties.type.const = "com.example.catalogue.beer.created.v2")],
  ["an operation removed", "breaking", (d) => delete d.operations.publish_beer_created],
  ["a channel's address changed", "breaking", (d) => (d.channels.beer_events.address = "beers")],
  ["a property called description removed", "breaking", (d) => {
    data(d).properties.description = { type: "string" };
    const before = structuredClone(d);
    delete data(d).properties.description;
    expect(changes(before, d).some((change) => change.level === "breaking")).toBe(true);
    delete data(d).properties.abv;
  }],
  ["required added to a payload that had none", "breaking", (d) => {
    delete data(d).required;
    const before = structuredClone(d);
    data(d).required = ["beer_id"];
    expect(changes(before, d).some((change) => change.level === "breaking")).toBe(true);
    delete data(d).properties.abv;
  }],
  ["a constraint added to a property", "breaking", (d) => (data(d).properties.name.maxLength = 10)],
  ["a payload closed to other properties", "breaking", (d) => (d.components.schemas.BeerCreatedEvent.allOf[1].additionalProperties = false)],
  ["an operation called summary removed", "breaking", (d) => {
    d.operations.summary = structuredClone(d.operations.publish_beer_created);
    const before = structuredClone(d);
    delete d.operations.summary;
    expect(changes(before, d).some((change) => change.level === "breaking")).toBe(true);
    delete d.operations.publish_beer_created;
  }],
])("%s is %s", (_, expected, edit) => {
  expect(verdict(edited(edit))).toBe(expected);
});

// --- The gates, as they are run ----------------------------------------------
// Each run starts node and loads AsyncAPI's parser; a test makes several.
vi.setConfig({ testTimeout: 120_000 });
const script = resolve("tools/asyncapi/asyncapi.ts");
const ENVELOPE = resolve("tools/asyncapi/cloudevent.yaml");
const tsx = import.meta.resolve("tsx");
const root = mkdtempSync(join(tmpdir(), "asyncapi-test-"));
// Never the repository these tests live in, whatever a hook has exported.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && name !== "SPEC_BASELINE")), NODE_OPTIONS: "" };
// The last published contract is the commit the fixture was made with.
const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, ["--import", tsx, script, ...args], { cwd, encoding: "utf8", env: { ...env, SPEC_BASELINE: "HEAD" } });
  return { status: result.status, output: result.stdout + result.stderr };
};
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
};
const write = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
const repository = (name: string, contract: string | null = CONTRACT) => {
  const dir = join(root, name);
  // The envelope every message extends is the skeleton's, beside its tools.
  mkdirSync(join(dir, "tools/asyncapi"), { recursive: true });
  cpSync(ENVELOPE, join(dir, "tools/asyncapi/cloudevent.yaml"));
  if (contract) write(dir, "specs/asyncapi.yaml", contract);
  write(dir, "specs/features/events.feature", FEATURE);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "published");
  return dir;
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("an API with no AsyncAPI contract has nothing to check", () => {
  const dir = repository("none", null);
  for (const command of ["check", "compat", "generate", "examples"]) {
    const result = run(dir, command);
    expect(result.output).toContain("no specs/asyncapi.yaml");
    expect(result.status).toBe(0);
  }
});

test("check passes a valid contract whose every operation has a scenario", () => {
  expect(run(repository("valid"), "check").output).toContain("asyncapi:check ok - 2 operations (1 received, 1 published)");
});

test("check names an operation no scenario is tagged for", () => {
  const dir = repository("uncovered");
  write(dir, "specs/features/events.feature", FEATURE.replace("  @operation:publish_beer_created\n", ""));
  const result = run(dir, "check");
  expect(result.status).toBe(1);
  expect(result.output).toContain("operation publish_beer_created has no scenario tagged @operation:publish_beer_created");
});

test("check says what is wrong with an invalid contract", () => {
  const result = run(repository("invalid", CONTRACT.replace("action: receive", "action: listen")), "check");
  expect(result.status).toBe(1);
  expect(result.output).toContain("not a valid AsyncAPI document");
  expect(result.output).toContain("action");
});

test("compat holds info.version to what changed", () => {
  const dir = repository("compat");
  const publish = (document: Document) => write(dir, "specs/asyncapi.yaml", stringify(document));
  const compat = () => run(dir, "compat");
  expect(compat().output).toContain("unchanged since");

  // A breaking change needs a new major version.
  const breaking = edited((d) => {
    delete data(d).properties.abv;
    data(d).required = ["beer_id", "name"];
  });
  publish({ ...breaking, info: { ...breaking.info, version: "1.1.0" } });
  expect(compat().status).toBe(1);
  expect(compat().output).toContain("needs a new major version");
  expect(compat().output).toContain("remove /components/schemas/BeerCreatedEvent/allOf/1/properties/data/properties/abv");
  publish({ ...breaking, info: { ...breaking.info, version: "2.0.0" } });
  expect(compat().output).toContain("asyncapi:compat ok - 1.0.0");

  // Any other change needs a new minor version; an edit that changes nothing, any new version.
  const added = edited((d) => (data(d).properties.brewery_id = { type: "string" }));
  publish(added);
  expect(compat().output).toContain("needs at least a new minor version");
  publish({ ...added, info: { ...added.info, version: "1.1.0" } });
  expect(compat().status).toBe(0);
  write(dir, "specs/asyncapi.yaml", `${CONTRACT}# a comment\n`);
  expect(compat().output).toContain("every published edit needs a new version");
});

test("every message is a CloudEvent with a type of its own, named the house way", () => {
  const problems = (name: string, edit: (document: Document) => void) => run(repository(name, stringify(edited(edit))), "check").output;
  const beer = (d: Document) => d.components.schemas.BeerCreatedEvent;
  expect(problems("bare", (d) => (beer(d).allOf = [beer(d).allOf[1]]))).toContain("message beer_created is not a CloudEvent: its payload must extend the envelope");
  expect(problems("untyped", (d) => delete beer(d).allOf[1].properties.type)).toContain("message beer_created does not fix its type");
  expect(problems("shared", (d) => (beer(d).allOf[1].properties.type.const = "com.example.registry.brewery.closed.v1"))).toContain("have the same type");
  expect(problems("dataless", (d) => (beer(d).allOf[1].required = []))).toContain("does not require and describe its data");
});

test("the house rules lint the contract's names and its event types", () => {
  const lint = (name: string, edit: (document: Document) => void) => {
    const dir = repository(name, stringify(edited(edit)));
    const result = spawnSync(resolve("node_modules/.bin/spectral"), ["lint", "specs/asyncapi.yaml", "--ruleset", resolve("rules/asyncapi.yaml"), "--fail-severity", "warn"], { cwd: dir, encoding: "utf8", env });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  expect(lint("clean", () => {}).status).toBe(0);
  const type = (value: string) => (d: Document) => (d.components.schemas.BeerCreatedEvent.allOf[1].properties.type.const = value);
  for (const [name, value] of Object.entries({ camel: "com.example.catalogue.BeerCreated.v1", unversioned: "com.example.catalogue.beer.created", short: "beer.created.v1" })) {
    const named = lint(name, type(value));
    expect(named.status).not.toBe(0);
    expect(named.output).toContain("house-event-type-naming");
  }
  // A property of the data that happens to be called type is not the event's type.
  expect(lint("inner", (d) => (data(d).properties.type = { type: "string", const: "lager" })).status).toBe(0);
  expect(lint("badmedia", (d) => (d.components.messages.beer_created.contentType = "application/json")).output).toContain("house-message-is-a-cloudevent");
  expect(lint("camel", (d) => (data(d).properties.beerId = { type: "string" })).output).toContain("house-property-names-snake-case");
});

test("message names are one of a kind and never a path", () => {
  const twice = edited((d) => (d.components.messages.beer_created.name = "brewery_closed"));
  const dir = repository("names", stringify(twice));
  const check = run(dir, "check");
  expect(check.status).toBe(1);
  expect(check.output).toContain('message name "brewery_closed" is used by more than one message');
  expect(run(dir, "examples").status).toBe(1);

  const path = repository("path", stringify(edited((d) => (d.components.messages.beer_created.name = "../../outside"))));
  expect(run(path, "check").output).toContain('message name "../../outside" is not lower snake_case');
  expect(run(path, "examples").status).toBe(1);
  expect(existsSync(join(root, "outside.json"))).toBe(false);
});

test("a schema that refers to itself is reported, not crashed on", () => {
  const recursive = edited((d) => {
    d.components.schemas.Node = { type: "object", properties: { children: { type: "array", items: { $ref: "#/components/schemas/Node" } } } };
    data(d).properties.tree = { $ref: "#/components/schemas/Node" };
  });
  const dir = repository("recursive", stringify(recursive));
  expect(run(dir, "check").output).toContain("asyncapi:check ok");
  expect(run(dir, "examples").status).toBe(0);
  const generated = run(dir, "generate");
  expect(generated.output).not.toContain("Maximum call stack");
});

test("two enums of the same name in different payloads keep their own values", () => {
  const enums = edited((d) => {
    data(d).properties.status = { type: "string", enum: ["draft", "live"] };
    d.components.schemas.BreweryClosedEvent.allOf[1].properties.data.properties.status = { type: "string", enum: ["closed", "sold"] };
  });
  const dir = repository("enums", stringify(enums));
  expect(run(dir, "generate").status).toBe(0);
  const types = readFileSync(join(dir, "src/generated/messages.d.ts"), "utf8");
  expect(types).toMatch(/"draft" \| "live"/);
  expect(types).toMatch(/"closed" \| "sold"/);
  expect(types).not.toMatch(/export enum/);
});

test("removing a published contract is breaking, and examples are not left behind", () => {
  const dir = repository("removed");
  run(dir, "examples");
  rmSync(join(dir, "specs/asyncapi.yaml"));
  const compat = run(dir, "compat");
  expect(compat.status).toBe(1);
  expect(compat.output).toContain("was removed, and with it 2 published operations");
  expect(run(dir, "examples", "check").output).toContain("still has examples");
  expect(run(dir, "check").status).toBe(0);
});

test("an example on a base schema is not taken for the whole message", () => {
  const dir = repository("based");
  const envelope = parse(readFileSync(ENVELOPE, "utf8")) as Document;
  envelope.CloudEvent.example = { id: "only-the-base" };
  write(dir, "tools/asyncapi/cloudevent.yaml", stringify(envelope));
  run(dir, "examples");
  expect(JSON.parse(readFileSync(join(dir, "messages/beer_created.json"), "utf8")).data).toEqual({ beer_id: "beer id", name: "name", abv: 0 });
});

test("a change to the envelope every message extends is a breaking change to the contract", () => {
  const dir = repository("envelope");
  const envelope = parse(readFileSync(ENVELOPE, "utf8")) as Document;
  expect(run(dir, "compat").output).toContain("unchanged since");
  // Words about it are not a change to it.
  envelope.CloudEvent.properties.id.description = "Reworded.";
  write(dir, "tools/asyncapi/cloudevent.yaml", stringify(envelope));
  expect(run(dir, "compat").output).toContain("unchanged since");
  envelope.CloudEvent.required.push("subject");
  write(dir, "tools/asyncapi/cloudevent.yaml", stringify(envelope));
  const compat = run(dir, "compat");
  expect(compat.status).toBe(1);
  expect(compat.output).toContain("tools/asyncapi/cloudevent.yaml - the envelope every message extends");
});

test("generate writes the resolved contract, a type for every payload and the table of operations", () => {
  const dir = repository("generated");
  expect(run(dir, "generate").status).toBe(0);
  const types = readFileSync(join(dir, "src/generated/messages.d.ts"), "utf8");
  expect(types).toContain("export interface BeerCreatedEvent {");
  expect(types).toContain("'type': 'com.example.catalogue.beer.created.v1';");
  expect(types).toContain("'data': BeerCreatedEventData;");
  expect(types).toContain("export interface BeerCreatedEventData {");
  expect(types).toContain("'style'?: string;");
  // Nothing is left for a reader to guess: no anonymous names, no `any`.
  expect(types).not.toMatch(/Anonymous|\bany\b/);
  const operations = readFileSync(join(dir, "src/generated/async-operations.ts"), "utf8");
  expect(operations).toContain('"id": "handle_brewery_closed"');
  expect(operations).toContain('"action": "receive"');
  expect(operations).toContain('"address": "beer-events"');
  expect(operations).toContain('"type": "com.example.catalogue.beer.created.v1"');
  expect(JSON.stringify(JSON.parse(readFileSync(join(dir, "src/generated/asyncapi.json"), "utf8")))).not.toContain("x-parser-");
});

test("examples are written from the contract and checked against it", () => {
  const dir = repository("examples");
  expect(run(dir, "examples", "check").status).toBe(1);
  expect(run(dir, "examples").status).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "messages/beer_created.json"), "utf8"))).toEqual({
    specversion: "1.0",
    id: "id",
    source: "source",
    type: "com.example.catalogue.beer.created.v1",
    time: "2026-01-01T00:00:00Z",
    data: { beer_id: "beer id", name: "name", abv: 0 },
  });
  expect(run(dir, "examples", "check").output).toContain("asyncapi:examples:check ok");
  // One that no longer matches, and one for a message that is gone.
  writeFileSync(join(dir, "messages/beer_created.json"), "{}\n");
  write(dir, "messages/old.json", "{}\n");
  const stale = run(dir, "examples", "check");
  expect(stale.output).toContain("messages/beer_created.json does not match the contract");
  expect(stale.output).toContain("messages/old.json is not a message in the contract");
  run(dir, "examples");
  expect(existsSync(join(dir, "messages/old.json"))).toBe(false);
});
