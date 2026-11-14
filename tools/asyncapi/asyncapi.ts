// The AsyncAPI contract, specs/asyncapi.yaml: the messages this API receives
// (`receive` operations) and the events it publishes (`send` operations). It
// is held to the same gates as the OpenAPI contract, with AsyncAPI's own
// tools: its parser, its diff, and Modelina for types.
//   node tools/asyncapi/asyncapi.ts check            - gate: valid, and every operation has a scenario tagged for it
//   node tools/asyncapi/asyncapi.ts compat           - gate: changes since the last published contract, and info.version says so
//   node tools/asyncapi/asyncapi.ts generate         - src/generated/: the resolved contract, message types, the table of operations
//   node tools/asyncapi/asyncapi.ts examples         - write messages/<message>.json, an example of every message
//   node tools/asyncapi/asyncapi.ts examples check   - gate: the committed examples match the contract
// An API with no asynchronous side has no specs/asyncapi.yaml, and every one
// of these then has nothing to do.
import { diff } from "@asyncapi/diff";
import { TypeScriptGenerator } from "@asyncapi/modelina";
import { type AsyncAPIDocumentInterface, Parser, fromFile } from "@asyncapi/parser";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { baseline, show } from "../../scripts/spec-baseline.ts";
import { type Schema, sample } from "../../scripts/sample.ts";

export const CONTRACT = "specs/asyncapi.yaml";
const FEATURES = "specs/features";
const EXAMPLES = "messages";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

// The contract as the parser understands it, or what is wrong with it.
async function load(path = CONTRACT): Promise<AsyncAPIDocumentInterface> {
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

type Operation = { id: string; action: "send" | "receive"; summary: string; channel: string; address: string; messages: { name: string; type?: string; payload: Schema }[] };

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
            return { name: message.name() ?? message.id(), type: eventType(payload), payload };
          }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
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
function named_or_stop(all: Operation[]): Operation[] {
  const problems = nameProblems(all);
  if (problems.length > 0) stop([`${CONTRACT} cannot be generated from:`, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  return all;
}

async function check(): Promise<void> {
  const all = operations(await load());
  const problems: string[] = nameProblems(all);
  const features = existsSync(FEATURES) ? readdirSync(FEATURES, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".feature")) : [];
  const tagged = new Set(features.flatMap((file) => [...readFileSync(join(FEATURES, file), "utf8").matchAll(/@operation:([\w.-]+)/g)].map(([, id]) => id!)));
  for (const operation of all) {
    if (!tagged.has(operation.id)) problems.push(`operation ${operation.id} has no scenario tagged @operation:${operation.id}`);
    if (operation.messages.length === 0) problems.push(`operation ${operation.id} names no message`);
    for (const message of operation.messages) {
      if (Object.keys(message.payload).length === 0) problems.push(`message ${message.name} (${operation.id}) has no payload schema`);
    }
  }
  if (problems.length > 0) stop(["asyncapi:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  const count = (action: string) => all.filter((operation) => operation.action === action).length;
  if (all.length === 0) return console.log(`asyncapi:check ok - ${CONTRACT} declares no operations; remove the file if this API has no asynchronous side`);
  console.log(`asyncapi:check ok - ${all.length} operations (${count("receive")} received, ${count("send")} published), every one has a scenario`);
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

async function compat(): Promise<void> {
  const skip = (why: string) => console.log(`asyncapi:compat skipped - ${why}`);
  const ref = baseline();
  if (!ref) return skip("there is no earlier commit to compare with");
  const before = show(ref, CONTRACT);
  if (before === undefined) return skip(`${ref.slice(0, 12)} has no ${CONTRACT}, so there is nothing to break`);
  const now = readFileSync(CONTRACT, "utf8");
  await load();
  type Document = { info?: { version?: string } };
  const [old, current] = [parseYaml(before) as Document, parseYaml(now) as Document];
  const found = changes(old, current).filter((change) => change.path !== "/info/version");
  const breaking = found.filter((change) => change.level === "breaking");
  // What the rules cannot place is shown, and treated as breaking until a person has looked.
  const unknown = found.filter((change) => change.level === "unclassified");

  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  const to = parse(current.info?.version) ?? stop(`asyncapi:compat failed\n  - info.version "${current.info?.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = to as [number, number, number];
  const [oldMajor, oldMinor, oldPatch] = (parse(old.info?.version) ?? [0, 0, 0]) as [number, number, number];
  const bumped = {
    major: major > oldMajor,
    minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
    any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
  };
  const from = `${old.info?.version} (at ${ref.slice(0, 12)})`;
  const edited = before.trim() !== now.trim();
  const problems: string[] = [];
  if (breaking.length + unknown.length > 0 && !(bumped.major || (oldMajor === 0 && bumped.minor))) {
    problems.push(
      `the contract has ${breaking.length > 0 ? "breaking changes" : "changes that could not be classified"} but info.version went from ${from} to ${current.info?.version}; that needs a new ${oldMajor === 0 ? "minor version (the contract is still 0.x)" : "major version"}`,
    );
  } else if (found.length > 0 && !bumped.minor) {
    problems.push(`the contract changed but info.version went from ${from} to ${current.info?.version}; a change needs at least a new minor version`);
  } else if (edited && !bumped.any) {
    problems.push(`the contract was edited but info.version is still ${current.info?.version}; every published edit needs a new version`);
  }
  const section = (title: string, list: Change[]) => (list.length > 0 ? [`  ${title}`, ...list.map((change) => `    ${change.action} ${change.path}`)] : []);
  const report = [
    ...section("Breaking changes - existing senders or consumers will fail:", breaking),
    ...section("Not classified - treated as breaking until a person decides:", unknown),
    ...section("Other changes:", found.filter((change) => change.level === "non-breaking")),
  ];
  if (problems.length > 0) stop(["asyncapi:compat failed", ...problems.map((problem) => `  - ${problem}`), ...report].join("\n"));
  console.log(
    [
      !edited
        ? `asyncapi:compat ok - the contract is unchanged since ${ref.slice(0, 12)}`
        : `asyncapi:compat ok - ${from} -> ${current.info?.version}: ${breaking.length} breaking, ${unknown.length} not classified, ${found.length - breaking.length - unknown.length} other changes`,
      ...report,
    ].join("\n"),
  );
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
  const document = await load();
  const all = named_or_stop(operations(document));
  mkdirSync("src/generated", { recursive: true });
  writeFileSync("src/generated/asyncapi.json", JSON.stringify(plain(document.json()), null, 2) + "\n");

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
  for (const message of document.allMessages().all()) {
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
    ["// Generated from specs/asyncapi.yaml by `task generate` (Modelina) - do not edit.", ...[...types.values()].map((type) => `export ${type}`), ""].join("\n\n"),
  );
  writeFileSync(
    "src/generated/async-operations.ts",
    [
      "// Generated from specs/asyncapi.yaml by `task generate` - do not edit.",
      "// Every operation of the AsyncAPI contract: what is received and what is published.",
      `export const asyncOperations = ${JSON.stringify(
        all.map(({ id, action, channel, address, messages }) => ({ id, action, channel, address, messages: messages.map(({ name, type }) => ({ name, type })) })),
        null,
        2,
      )} as const;`,
      "",
    ].join("\n"),
  );
  console.log(`generated src/generated/{asyncapi.json,messages.d.ts,async-operations.ts} from ${CONTRACT}`);
}

async function examples(mode: string | undefined): Promise<void> {
  const all = named_or_stop(operations(await load()));
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
  const ref = command === "compat" ? baseline() : undefined;
  const before = ref ? show(ref, CONTRACT) : undefined;
  const published = Object.keys((before ? (parseYaml(before) as { operations?: object } | null) : null)?.operations ?? {});
  if (published.length > 0) {
    stop(
      [
        "asyncapi:compat failed",
        `  - ${CONTRACT} was removed, and with it ${published.length} published operations (${published.join(", ")}). Whoever sends or consumes them will fail.`,
        "    Remove the operations first, in a new major version of the contract that is published; delete the file in a later change.",
      ].join("\n"),
    );
  }
  const left = command === "examples" && mode === "check" && existsSync(EXAMPLES) ? readdirSync(EXAMPLES).filter((file) => file.endsWith(".json")) : [];
  if (left.length > 0) stop(`asyncapi:examples:check failed\n  - ${EXAMPLES}/ still has examples (${left.join(", ")}) but there is no ${CONTRACT}; remove them`);
  console.log(`asyncapi:${command ?? "check"} - no ${CONTRACT}, so this API has no asynchronous side to check`);
}

// Run as a script, not when imported by a test.
if (process.argv[1]?.endsWith("asyncapi.ts")) {
  const [command, mode] = process.argv.slice(2);
  try {
    if (!existsSync(CONTRACT)) absent(command, mode);
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
