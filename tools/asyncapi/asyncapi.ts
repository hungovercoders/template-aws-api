// The AsyncAPI contracts, specs/contracts/asyncapi.v<N>.yaml - one for each live major:
// the messages this API receives (`receive` operations) and the events it
// publishes (`send` operations). The stack receives and publishes what every
// live major holds; an event's own version is its type's .v<M>, and its
// message and operations end _v<M> (scripts/contracts.ts). They are held to
// the same gates as the OpenAPI contracts, with AsyncAPI's own tools: its
// parser, its diff, and Modelina for types.
//   node tools/asyncapi/asyncapi.ts check            - gate: valid, and every operation has a scenario tagged for it
//   node tools/asyncapi/asyncapi.ts compat           - gate: changes since the last published contract, and info.version says so
//   node tools/asyncapi/asyncapi.ts generate         - src/generated/: the resolved contract, message types, the table of operations
//   node tools/asyncapi/asyncapi.ts examples         - write messages/<message>.json, an example of every message
//   node tools/asyncapi/asyncapi.ts examples check   - gate: the committed examples match the contract
// An API with no asynchronous side has no specs/contracts/asyncapi.v<N>.yaml, and every
// one of these then has nothing to do.
import { diff } from "@asyncapi/diff";
import { TypeScriptGenerator } from "@asyncapi/modelina";
import { type AsyncAPIDocumentInterface, Parser, fromFile } from "@asyncapi/parser";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { asyncapiNameProblems, atBaseline, type Contract, contracts, misnamed, operationTags, retired, versionProblems } from "../../scripts/contracts.ts";
import { baseline, show } from "../../scripts/spec-baseline.ts";
import { type Schema, merged, sample } from "../../scripts/sample.ts";

/** How the contracts are named in what this says: one file, or the pattern. */
const CONTRACT = "specs/contracts/asyncapi.v<N>.yaml";
const FEATURES = "specs/features";
const EXAMPLES = "messages";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

// The contract as the parser understands it, or what is wrong with it.
async function load(path: string): Promise<AsyncAPIDocumentInterface> {
  const { document, diagnostics } = await fromFile(new Parser(), path).parse();
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 0);
  if (!document || errors.length > 0) {
    stop([`${path} is not a valid AsyncAPI document:`, ...errors.map((error) => `    ${error.path.join(".") || "document"}: ${error.message}`)].join("\n"));
  }
  if (!document!.version().startsWith("3.")) stop(`${path} is AsyncAPI ${document!.version()}; the template's gates and generators are for AsyncAPI 3`);
  return document!;
}

// The parser annotates what it resolves; none of that is the contract. It
// also resolves a schema that refers to itself into a loop, which no
// generator here can follow: the loop is cut where it closes.
function plain<T>(value: T, keep: (key: string) => boolean = (key) => !key.startsWith("x-parser-"), path: object[] = []): T {
  if (!value || typeof value !== "object") return value;
  if (path.includes(value)) return {} as T;
  const inner = [...path, value];
  if (Array.isArray(value)) return value.map((item) => plain(item, keep, inner)) as T;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => keep(key))
      .map(([key, item]) => [key, plain(item, keep, inner)]),
  ) as T;
}

type Operation = { id: string; action: "send" | "receive"; summary: string; channel: string; address: string; messages: { name: string; type?: string; contentType?: string; payload: Schema }[] };

// The `type` a CloudEvent payload fixes with a const, wherever allOf puts it.
function eventType(schema: Schema | undefined): string | undefined {
  if (!schema) return undefined;
  const own = schema.properties?.type?.const;
  if (typeof own === "string") return own;
  for (const part of schema.allOf ?? []) {
    const found = eventType(part);
    if (found) return found;
  }
  return undefined;
}

function operations(document: AsyncAPIDocumentInterface): Operation[] {
  return document
    .operations()
    .all()
    .map((operation) => {
      const channel = operation.channels().all()[0];
      return {
        id: operation.id() ?? "",
        action: operation.action() as "send" | "receive",
        summary: operation.summary() ?? "",
        channel: channel?.id() ?? "",
        address: channel?.address() ?? "",
        messages: operation
          .messages()
          .all()
          .map((message) => {
            const payload = plain(message.payload()?.json() ?? {}) as Schema;
            return { name: message.name() ?? message.id(), type: eventType(payload), contentType: message.contentType(), payload };
          }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
type Loaded = { contract: Contract; document: AsyncAPIDocumentInterface; operations: Operation[] };
async function loadAll(): Promise<Loaded[]> {
  const loaded: Loaded[] = [];
  for (const contract of contracts("asyncapi")) {
    const document = await load(contract.path);
    loaded.push({ contract, document, operations: operations(document) });
  }
  return loaded;
}

// What the stack receives and publishes: every live major's operations. One
// that two majors both hold is the same operation, so it must be the same in both.
function union(loaded: Loaded[]): { all: Operation[]; problems: string[] } {
  const byId = new Map<string, { operation: Operation; path: string }>();
  const problems: string[] = [];
  for (const { contract, operations: own } of loaded) {
    for (const operation of own) {
      const seen = byId.get(operation.id);
      if (!seen) byId.set(operation.id, { operation, path: contract.path });
      else if (JSON.stringify(seen.operation) !== JSON.stringify(operation)) {
        problems.push(`operation ${operation.id} is in ${seen.path} and ${contract.path} but not the same in both; a changed operation is a new version (_v<M+1>)`);
      }
    }
  }
  return { all: [...byId.values()].map(({ operation }) => operation).sort((a, b) => a.id.localeCompare(b.id)), problems };
}

// Every message once, whichever operations use it.
const messagesOf = (all: Operation[]) => [...new Map(all.flatMap((operation) => operation.messages).map((message) => [message.name, message])).values()];

// A message's name is its example's file name and its type's name, so it is
// one of a kind and never a path.
const SNAKE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
function nameProblems(all: Operation[]): string[] {
  const names = all.flatMap((operation) => operation.messages.map((message) => message.name));
  return [
    ...[...new Set(names)].filter((name) => !SNAKE.test(name)).map((name) => `message name "${name}" is not lower snake_case`),
    ...[...new Set(names.filter((name, index) => names.indexOf(name) !== index))].map((name) => `message name "${name}" is used by more than one message`),
  ];
}
function named_or_stop({ all, problems: unequal }: { all: Operation[]; problems: string[] }): Operation[] {
  const problems = [...unequal, ...nameProblems(all)];
  if (problems.length > 0) stop([`${CONTRACT} cannot be generated from:`, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  return all;
}

// Every message is a CloudEvent: the skeleton's envelope (cloudevent.yaml),
// with a `type` the message fixes and a `data` it describes.
const ENVELOPE = ["specversion", "id", "source", "type", "time"];
function envelopeProblems(all: Operation[]): string[] {
  const problems: string[] = [];
  const types = new Map<string, string>();
  for (const message of messagesOf(all)) {
    const schema = merged(message.payload);
    const missing = ENVELOPE.filter((attribute) => !schema.required?.includes(attribute) || !schema.properties?.[attribute]);
    if (missing.length > 0 || schema.properties?.specversion?.const !== "1.0") {
      problems.push(`message ${message.name} is not a CloudEvent: its payload must extend the envelope - allOf: [{ $ref: '../../tools/asyncapi/cloudevent.yaml#/CloudEvent' }, ...]`);
      continue;
    }
    // How a type is spelt, and the content type, are house rules: asyncapi:lint.
    if (!message.type) problems.push(`message ${message.name} does not fix its type: add properties.type.const`);
    else if (types.has(message.type)) problems.push(`messages ${types.get(message.type)} and ${message.name} have the same type "${message.type}"; a type names one message`);
    else types.set(message.type, message.name);
    if (!schema.properties?.data || !schema.required?.includes("data")) problems.push(`message ${message.name} does not require and describe its data`);
  }
  return problems;
}

async function check(): Promise<void> {
  const loaded = await loadAll();
  const { all, problems: unequal } = union(loaded);
  const problems: string[] = [...misnamed("asyncapi"), ...unequal, ...nameProblems(all), ...envelopeProblems(all)];
  for (const { contract, operations: own } of loaded) {
    problems.push(...versionProblems(contract, parseYaml(readFileSync(contract.path, "utf8"))), ...asyncapiNameProblems(contract.path, own));
  }
  const features = existsSync(FEATURES) ? readdirSync(FEATURES, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".feature")) : [];
  const tagged = new Set(features.flatMap((file) => operationTags(readFileSync(join(FEATURES, file), "utf8"))));
  for (const operation of all) {
    if (!tagged.has(operation.id)) problems.push(`operation ${operation.id} has no scenario tagged @operation:${operation.id}`);
    if (operation.messages.length === 0) problems.push(`operation ${operation.id} names no message`);
    for (const message of operation.messages) {
      if (Object.keys(message.payload).length === 0) problems.push(`message ${message.name} (${operation.id}) has no payload schema`);
    }
  }
  if (problems.length > 0) stop(["asyncapi:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  const count = (action: string) => all.filter((operation) => operation.action === action).length;
  const files = loaded.map(({ contract }) => contract.path).join(", ");
  if (all.length === 0) return console.log(`asyncapi:check ok - ${files} declare no operations; remove them if this API has no asynchronous side`);
  console.log(`asyncapi:check ok - ${all.length} operations (${count("receive")} received, ${count("send")} published) in ${files}, every one has a scenario`);
}

// --- Compatibility -----------------------------------------------------------
// AsyncAPI's diff finds what changed and says how serious it is from a table of
// document paths. Its table for AsyncAPI 3 stops at a message's payload, so
// what happens inside a schema is "unclassified". These rules carry it down:
// something added is not breaking, something removed or changed is.
// The diff compares paths, so it cannot tell a message this API sends from one
// it receives. The rules are therefore the cautious ones for both: a property
// made required is breaking (it is, for a message received), and so is one
// removed (it is, for an event published).
type Level = "breaking" | "non-breaking" | "unclassified";
type Rule = { add: Level; remove: Level; edit: Level };
const STRICT: Rule = { add: "non-breaking", remove: "breaking", edit: "breaking" };
const FREE: Rule = { add: "non-breaking", remove: "non-breaking", edit: "non-breaking" };
function rules(): Record<string, Rule> {
  const table: Record<string, Rule> = { "/info/version": FREE };
  for (const path of ["/components/schemas", "/components/messages", "/components/messages/*", "/components/messages/*/name", "/components/messages/*/contentType"]) table[path] = STRICT;
  for (const key of ["title", "summary", "description", "examples", "examples/*", "tags", "tags/*", "externalDocs"]) table[`/components/messages/*/${key}`] = FREE;
  // The table is matched one path segment at a time, so each depth is its own entry.
  for (const base of ["/components/schemas/*", "/components/messages/*/payload", "/components/messages/*/headers", "/channels/*/messages/*/payload", "/channels/*/messages/*/headers"]) {
    for (let depth = 0, path = base; depth < 40; depth++, path += "/*") table[path] = STRICT;
  }
  return table;
}
// Words about a schema are not the schema.
const WORDS = new Set(["description", "title", "example", "examples", "$comment", "deprecated"]);
// Keywords that narrow what a schema accepts. One added to a schema that was
// already published refuses something that used to be allowed.
const NARROWING = new Set([
  ...["required", "enum", "const", "type", "format", "pattern", "additionalProperties", "propertyNames", "not", "allOf", "anyOf", "oneOf", "if", "then", "else"],
  ...["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties"],
]);
type Change = { action: "add" | "remove" | "edit"; path: string; type: Level };
function level(change: Change): Level {
  const parts = change.path.split("/");
  const last = parts.at(-1)!;
  // Only inside a schema; elsewhere a path ends in the name of an operation or a message.
  const inSchema = change.path.startsWith("/components/schemas/") || parts.includes("payload") || parts.includes("headers");
  if (!inSchema) return change.type;
  // A keyword is a keyword unless it is the name of a property.
  const keyword = parts.at(-2) !== "properties";
  if (keyword && WORDS.has(last)) return "non-breaking";
  if (change.action === "add" && ((keyword && NARROWING.has(last)) || parts.at(-2) === "required" || parts.at(-2) === "allOf")) return "breaking";
  return change.type;
}

export function changes(before: unknown, after: unknown): (Change & { level: Level })[] {
  const output = diff(before as never, after as never, { override: rules() as never });
  return ([...output.breaking(), ...output.nonBreaking(), ...output.unclassified()] as Change[]).map((change) => ({ ...change, level: level(change) }));
}

// Every message extends the skeleton's envelope by reference, so a change to
// that file changes every message without touching the contract. Words aside,
// any difference in it is treated as breaking.
const ENVELOPE_FILE = "tools/asyncapi/cloudevent.yaml";

/**
 * The contract with every reference to the envelope written one way. Where the contract sits
 * decides how its relative path to the envelope is spelt (../ from specs/, ../../ from
 * specs/contracts/); that is not a change to any message - a change to the envelope itself is
 * envelopeChanges' to find.
 */
export function enveloped(document: unknown): unknown {
  if (Array.isArray(document)) return document.map(enveloped);
  if (document === null || typeof document !== "object") return document;
  return Object.fromEntries(
    Object.entries(document).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string" ? value.replace(new RegExp(`^(?:\\.\\./)+${ENVELOPE_FILE.replace(/[./]/g, "\\$&")}#`), `${ENVELOPE_FILE}#`) : enveloped(value),
    ]),
  );
}
function envelopeChanges(ref: string): (Change & { level: Level })[] {
  const before = show(ref, ENVELOPE_FILE);
  if (before === undefined || !existsSync(ENVELOPE_FILE)) return [];
  const wordless = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(wordless)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !WORDS.has(key))
              .map(([key, inner]) => [key, wordless(inner)]),
          )
        : value;
  const same = JSON.stringify(wordless(parseYaml(before))) === JSON.stringify(wordless(parseYaml(readFileSync(ENVELOPE_FILE, "utf8"))));
  return same ? [] : [{ action: "edit", path: `${ENVELOPE_FILE} - the envelope every message extends`, type: "breaking", level: "breaking" }];
}

async function compat(): Promise<void> {
  const ref = baseline();
  if (!ref) return console.log("asyncapi:compat skipped - there is no earlier commit to compare with");
  const short = ref.slice(0, 12);
  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  type Document = { info?: { version?: string } };
  const problems: string[] = [];
  const report: string[] = [];
  const envelope = envelopeChanges(ref);

  for (const contract of contracts("asyncapi")) {
    await load(contract.path);
    const label = `v${contract.major} (${contract.path})`;
    const before = atBaseline(contract, ref);
    if (before === undefined) {
      report.push(`  ${label}: new since ${short} - a new major has nothing published to break`);
      continue;
    }
    const now = readFileSync(contract.path, "utf8");
    const [old, current] = [enveloped(parseYaml(before)) as Document, enveloped(parseYaml(now)) as Document];
    const found = [...changes(old, current).filter((change) => change.path !== "/info/version"), ...envelope];
    const breaking = found.filter((change) => change.level === "breaking");
    // What the rules cannot place is shown, and treated as breaking until a person has looked.
    const unknown = found.filter((change) => change.level === "unclassified");

    const to = parse(current.info?.version);
    if (!to) {
      problems.push(`${contract.path}: info.version "${current.info?.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
      continue;
    }
    const [major, minor, patch] = to as [number, number, number];
    const [oldMajor, oldMinor, oldPatch] = (parse(old.info?.version) ?? [0, 0, 0]) as [number, number, number];
    const bumped = {
      minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
      any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
    };
    const from = `${old.info?.version} (at ${short})`;
    // The text, with the envelope's path spelt one way (enveloped): moving the file is not an edit.
    const spelt = (text: string) => text.replace(/(?:\.\.\/)+tools\/asyncapi\/cloudevent\.yaml#/g, `${ENVELOPE_FILE}#`).trim();
    const edited = spelt(before) !== spelt(now) || found.length > 0;
    if (breaking.length + unknown.length > 0 && !(oldMajor === 0 && bumped.minor)) {
      const what = breaking.length > 0 ? "breaking changes" : "changes that could not be classified";
      problems.push(
        oldMajor === 0
          ? `${contract.path} has ${what} but info.version went from ${from} to ${current.info?.version}; while the contract is 0.x that needs a new minor version`
          : `${contract.path} has ${what}: whoever sends or consumes v${contract.major} would fail. Publish a changed event as a new version beside the old one (a type ending .v<M+1>, a message and operations ending _v<M+1>), or make the change in specs/contracts/asyncapi.v${contract.major + 1}.yaml, and leave v${contract.major} as it is`,
      );
    } else if (found.length > 0 && !bumped.minor) {
      problems.push(`${contract.path} changed but info.version went from ${from} to ${current.info?.version}; a change needs at least a new minor version`);
    } else if (edited && !bumped.any) {
      problems.push(`${contract.path} was edited but info.version is still ${current.info?.version}; every published edit needs a new version`);
    }
    const section = (title: string, list: Change[]) => (list.length > 0 ? [`    ${title}`, ...list.map((change) => `      ${change.action} ${change.path}`)] : []);
    report.push(
      edited
        ? `  ${label}: ${from} -> ${current.info?.version}: ${breaking.length} breaking, ${unknown.length} not classified, ${found.length - breaking.length - unknown.length} other changes`
        : `  ${label}: unchanged since ${short}`,
      ...section("Breaking changes - existing senders or consumers will fail:", breaking),
      ...section("Not classified - treated as breaking until a person decides:", unknown),
      ...section("Other changes:", found.filter((change) => change.level === "non-breaking")),
    );
  }
  const { gone, problems: unannounced } = retired("asyncapi", ref);
  problems.push(...unannounced);
  report.push(...gone.filter((contract) => !unannounced.some((problem) => problem.startsWith(contract.path))).map((contract) => `  v${contract.major} (${contract.path}): retired - it was published deprecated`));
  if (problems.length > 0) stop(["asyncapi:compat failed", ...problems.map((problem) => `  - ${problem}`), ...report].join("\n"));
  console.log([`asyncapi:compat ok - compared with ${short}`, ...report].join("\n"));
}

// --- Generated ---------------------------------------------------------------
type Named = Schema & { $id?: string; title?: string; "x-parser-schema-id"?: string };
const pascal = (name: string) =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
// The name a schema has in components.schemas; the parser records it.
const schemaName = (schema: Named) => (schema["x-parser-schema-id"] && !schema["x-parser-schema-id"].startsWith("<") ? schema["x-parser-schema-id"] : undefined);
// Give every object schema a name of its own, so a nested one is called after
// where it is (BeerCreatedEventData), not after the order it was met in.
function named(schema: Named, name: string): Named {
  const { "x-parser-schema-id": _, ...rest } = schema;
  const own = schemaName(schema) ?? name;
  return {
    ...rest,
    ...(schema.type === "object" || schema.properties || schema.allOf || schema.enum ? { $id: own, title: schema.title ?? own } : {}),
    ...(schema.allOf ? { allOf: schema.allOf.map((part) => named(part as Named, own)) } : {}),
    ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, named(value as Named, own + pascal(key))])) } : {}),
    ...(schema.items ? { items: named(schema.items as Named, `${own}Item`) } : {}),
  };
}

async function generate(): Promise<void> {
  const loaded = await loadAll();
  const all = named_or_stop(union(loaded));
  mkdirSync("src/generated", { recursive: true });
  // Every live major in one document: what the runtime receives and publishes.
  type Json = { info?: unknown; channels?: Record<string, { messages?: Record<string, unknown> }>; operations?: Record<string, unknown> };
  const merged: Required<Pick<Json, "channels" | "operations">> & Json = { channels: {}, operations: {} };
  for (const { document } of loaded) {
    const json = plain(document.json()) as Json;
    merged.info = json.info;
    for (const [id, channel] of Object.entries(json.channels ?? {})) {
      merged.channels[id] = { ...merged.channels[id], ...channel, messages: { ...merged.channels[id]?.messages, ...channel.messages } };
    }
    Object.assign(merged.operations, json.operations ?? {});
  }
  writeFileSync("src/generated/asyncapi.json", JSON.stringify({ asyncapi: loaded.at(-1)!.document.version(), ...merged }, null, 2) + "\n");

  // Modelina is given each message's payload schema, not the document: it then
  // does not depend on which AsyncAPI version Modelina has caught up with
  // (5.10 reads a 3.1 document as nothing, and says so with `any`).
  // An open schema is not a property called "additionalProperties": leave that member out.
  const generator = new TypeScriptGenerator({
    modelType: "interface",
    enumType: "union",
    rawPropertyNames: true,
    presets: [{ interface: { property: ({ content }) => (/^\s*'additionalProperties'\?: Map<string, any>;\s*$/.test(content) ? "" : content) } }],
  });
  const types = new Map<string, string>();
  for (const message of loaded.flatMap(({ document }) => document.allMessages().all())) {
    const raw = message.payload()?.json();
    if (!raw) continue;
    // Loops cut, the parser's notes dropped - but not the names it recorded.
    const payload = plain(raw, (key) => key === "x-parser-schema-id" || !key.startsWith("x-parser-")) as Named;
    const name = message.name() ?? message.id();
    for (const model of await generator.generate(named(payload, schemaName(payload) ?? pascal(name)))) {
      if (/=\s*any;/.test(model.result)) stop(`asyncapi: Modelina could not make a type for the payload of ${name} (a schema that refers to itself is not supported)`);
      if (types.has(model.modelName) && types.get(model.modelName) !== model.result) {
        stop(`asyncapi: two different schemas would both be the type ${model.modelName}; give one a name of its own in components.schemas`);
      }
      types.set(model.modelName, model.result);
    }
  }
  writeFileSync(
    "src/generated/messages.d.ts",
    ["// Generated from specs/contracts/asyncapi.v<N>.yaml by `task generate` (Modelina) - do not edit.", ...[...types.values()].map((type) => `export ${type}`), ""].join("\n\n"),
  );
  writeFileSync(
    "src/generated/async-operations.ts",
    [
      "// Generated from specs/contracts/asyncapi.v<N>.yaml by `task generate` - do not edit.",
      "// Every operation of every live major of the AsyncAPI contract: what is received and what is published.",
      `export const asyncOperations = ${JSON.stringify(
        all.map(({ id, action, channel, address, messages }) => ({ id, action, channel, address, messages: messages.map(({ name, type }) => ({ name, type })) })),
        null,
        2,
      )} as const;`,
      "",
    ].join("\n"),
  );
  console.log(`generated src/generated/{asyncapi.json,messages.d.ts,async-operations.ts} from ${loaded.map(({ contract }) => contract.path).join(", ")}`);
}

async function examples(mode: string | undefined): Promise<void> {
  const all = named_or_stop(union(await loadAll()));
  const wanted = new Map(messagesOf(all).map((message) => [`${message.name}.json`, JSON.stringify(sample(message.payload, message.name), null, 2) + "\n"] as [string, string]));
  const have = existsSync(EXAMPLES) ? readdirSync(EXAMPLES).filter((file) => file.endsWith(".json")) : [];
  if (mode === "check") {
    const problems = [
      ...[...wanted].filter(([file, text]) => !existsSync(join(EXAMPLES, file)) || readFileSync(join(EXAMPLES, file), "utf8") !== text).map(([file]) => `${EXAMPLES}/${file} does not match the contract`),
      ...have.filter((file) => !wanted.has(file)).map((file) => `${EXAMPLES}/${file} is not a message in the contract`),
    ];
    if (problems.length > 0) stop(["asyncapi:examples:check failed", ...problems.map((problem) => `  - ${problem}`), "  Run `task asyncapi:examples` and commit the result."].join("\n"));
    return console.log(`asyncapi:examples:check ok - ${EXAMPLES}/ has an example of each of the ${wanted.size} messages`);
  }
  mkdirSync(EXAMPLES, { recursive: true });
  for (const file of have.filter((file) => !wanted.has(file))) rmSync(join(EXAMPLES, file));
  for (const [file, text] of wanted) writeFileSync(join(EXAMPLES, file), text);
  console.log(`asyncapi:examples - ${EXAMPLES}/ has an example of each of the ${wanted.size} messages`);
}

// With no contract there is nothing to hold - unless one was published and
// has gone, or its examples were left behind.
function absent(command: string | undefined, mode: string | undefined): void {
  const wrong = misnamed("asyncapi");
  if (wrong.length > 0) stop([`asyncapi:${command ?? "check"} failed`, ...wrong.map((problem) => `  - ${problem}`)].join("\n"));
  const ref = command === "compat" ? baseline() : undefined;
  if (ref) {
    // A contract from before files were versioned, gone with its operations.
    const legacy = show(ref, "specs/contracts/asyncapi.yaml");
    const published = Object.keys((legacy ? (parseYaml(legacy) as { operations?: object } | null) : null)?.operations ?? {});
    const unannounced = [
      ...retired("asyncapi", ref).problems,
      ...(published.length > 0 ? [`specs/contracts/asyncapi.yaml was removed, and with it ${published.length} published operations (${published.join(", ")}). Whoever sends or consumes them will fail. First publish it deprecated (set \`info.x-deprecated: true\` in it), then remove it in a later change.`] : []),
    ];
    if (unannounced.length > 0) stop(["asyncapi:compat failed", ...unannounced.map((problem) => `  - ${problem}`)].join("\n"));
  }
  // The runtime imports what generate writes, contract or not.
  if (command === "generate") {
    mkdirSync("src/generated", { recursive: true });
    writeFileSync("src/generated/asyncapi.json", "{}\n");
    writeFileSync("src/generated/messages.d.ts", "// Generated by `task generate` - there is no specs/contracts/asyncapi.v<N>.yaml.\nexport {};\n");
    writeFileSync("src/generated/async-operations.ts", "// Generated by `task generate` - there is no specs/contracts/asyncapi.v<N>.yaml.\nexport const asyncOperations = [] as const;\n");
  }
  const left = command === "examples" && mode === "check" && existsSync(EXAMPLES) ? readdirSync(EXAMPLES).filter((file) => file.endsWith(".json")) : [];
  if (left.length > 0) stop(`asyncapi:examples:check failed\n  - ${EXAMPLES}/ still has examples (${left.join(", ")}) but there is no ${CONTRACT}; remove them`);
  console.log(`asyncapi:${command ?? "check"} - no ${CONTRACT}, so this API has no asynchronous side to check`);
}

// Run as a script, not when imported by a test.
if (process.argv[1]?.endsWith("asyncapi.ts")) {
  const [command, mode] = process.argv.slice(2);
  try {
    if (contracts("asyncapi").length === 0) absent(command, mode);
    else if (command === "check") await check();
    else if (command === "compat") await compat();
    else if (command === "generate") await generate();
    else if (command === "examples") await examples(mode);
    else stop("asyncapi: check | compat | generate | examples [check]");
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
