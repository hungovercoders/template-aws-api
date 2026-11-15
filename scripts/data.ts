// The data contract (specs/datacontract.yaml): what the events this API
// publishes are once they have landed in S3 - an Open Data Contract Standard
// document, with a schema object for every event.
//   node scripts/data.ts generate   - write into the contract what follows from the AsyncAPI contract: a schema
//                                     object for every event it publishes, each property's type and whether it
//                                     is required. What a person wrote (owner, classification, quality) is kept
//   node scripts/data.ts check      - gate: the contract is of the pinned ODCS version, agrees with the AsyncAPI
//                                     contract, and says what the infrastructure needs (where, how long, how fresh)
//   node scripts/data.ts compat     - gate: changes since the last published contract are listed, and its
//                                     version is bumped to match (breaking needs a major)
// The Data Contract CLI does the rest: `task data:lint` (valid ODCS) and
// `task data:test` (the data that landed keeps the contract).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { merged, type Schema } from "./sample.ts";
import { baseline, show } from "./spec-baseline.ts";

export const CONTRACT = "specs/datacontract.yaml";
const ASYNCAPI = "src/generated/asyncapi.json";
/** The one place the ODCS version is chosen (Taskfile.yml); moving to the next is one change there. */
const ODCS = process.env.ODCS_VERSION ?? "v3.2.0";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

// --- What follows from the AsyncAPI contract ---------------------------------

type Derived = { name: string; logicalType: string; required: boolean; description?: string; options?: Record<string, unknown>; properties?: Derived[]; items?: Derived };
type Event = { name: string; type: string; title?: string; summary?: string; properties: Derived[] };
type Json = Schema & { description?: string; maximum?: number; maxLength?: number; pattern?: string; title?: string };

function derivedFrom(name: string, given: Json, required: boolean): Derived {
  const schema = merged(given) as Json;
  const type = Array.isArray(schema.type) ? schema.type.find((one) => one !== "null") : schema.type;
  const logicalType =
    type === "string" && schema.format === "date-time" ? "timestamp" : type === "string" && schema.format === "date" ? "date" : type && ["string", "integer", "number", "boolean", "object", "array"].includes(type) ? type : schema.properties ? "object" : "string";
  // What the type allows, where ODCS has a word for it.
  const options = Object.fromEntries(
    Object.entries({
      format: logicalType === "string" && ["email", "uuid", "uri", "hostname", "ipv4", "ipv6", "password"].includes(schema.format ?? "") ? schema.format : undefined,
      minLength: schema.minLength,
      maxLength: schema.maxLength,
      pattern: schema.pattern,
      minimum: schema.minimum,
      maximum: schema.maximum,
    }).filter(([, value]) => value !== undefined),
  );
  return {
    name,
    logicalType,
    required,
    description: schema.description,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(logicalType === "object" ? { properties: Object.entries(schema.properties ?? {}).map(([key, property]) => derivedFrom(key, property as Json, (schema.required ?? []).includes(key))) } : {}),
    ...(logicalType === "array" && schema.items ? { items: derivedFrom("items", schema.items as Json, false) } : {}),
  };
}

/** Every event the AsyncAPI contract says the API publishes, as `task generate` resolved it. */
export function published(path = ASYNCAPI): Event[] {
  if (!existsSync(path)) return [];
  type Message = { name?: string; title?: string; summary?: string; payload?: Json };
  const document = JSON.parse(readFileSync(path, "utf8")) as { operations?: Record<string, { action?: string; messages?: Message[] }> };
  const events = new Map<string, Event>();
  for (const operation of Object.values(document.operations ?? {})) {
    if (operation.action !== "send") continue;
    for (const message of operation.messages ?? []) {
      const payload = merged(message.payload ?? {}) as Json;
      const type = payload.properties?.type?.const;
      if (!message.name || typeof type !== "string") continue;
      events.set(message.name, { name: message.name, type, title: message.title, summary: message.summary, properties: derivedFrom(message.name, payload, true).properties ?? [] });
    }
  }
  return [...events.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// --- Written into the data contract ------------------------------------------

const named = (seq: YAMLSeq, name: string) => seq.items.find((item): item is YAMLMap => isMap(item) && item.get("name") === name);
function seqAt(doc: Document, map: YAMLMap | Document, key: string): YAMLSeq {
  const found = map.get(key, true);
  // An empty list written as [] would keep everything added to it on one line.
  if (isSeq(found) && !(found.flow && found.items.length === 0)) return found;
  const made = doc.createNode([]) as YAMLSeq;
  made.flow = false;
  map.set(key, made);
  return made;
}

function write(doc: Document, into: YAMLMap, derived: Derived, at: string, strays: string[]): void {
  into.set("logicalType", derived.logicalType);
  // ODCS reads an absent `required` as false; only what is required says so.
  if (derived.required) into.set("required", true);
  else into.delete("required");
  if (derived.options) into.set("logicalTypeOptions", doc.createNode(derived.options));
  else into.delete("logicalTypeOptions");
  // Words are a person's once they are there.
  if (derived.description && !into.has("description")) into.set("description", derived.description);
  if (derived.properties) properties(doc, seqAt(doc, into, "properties"), derived.properties, at, strays);
  else into.delete("properties");
  if (derived.items) {
    if (!isMap(into.get("items", true))) into.set("items", doc.createNode({}));
    write(doc, into.get("items", true) as unknown as YAMLMap, derived.items, `${at}[]`, strays);
  } else into.delete("items");
}

function properties(doc: Document, seq: YAMLSeq, wanted: Derived[], at: string, strays: string[]): void {
  for (const derived of wanted) {
    let property = named(seq, derived.name);
    if (!property) {
      property = doc.createNode({ name: derived.name }) as YAMLMap;
      seq.add(property);
    }
    write(doc, property, derived, `${at}.${derived.name}`, strays);
  }
  for (const item of seq.items) {
    const name = isMap(item) ? String(item.get("name")) : "?";
    if (!wanted.some((derived) => derived.name === name)) strays.push(`${at}.${name} is not a property of the event in the AsyncAPI contract`);
  }
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function starter(): string {
  const title = existsSync(ASYNCAPI) ? ((JSON.parse(readFileSync(ASYNCAPI, "utf8")) as { info?: { title?: string } }).info?.title ?? "") : "";
  const name = title.replace(/\s+(messages|events)$/i, "") || "API";
  return [`apiVersion: ${ODCS}`, "kind: DataContract", `id: ${slug(name)}-events`, `name: ${name} events`, "version: 0.1.0", "status: draft", ""].join("\n");
}

/** The contract with everything the AsyncAPI contract decides written in, and what is in it that should not be. */
export function generated(text: string, events: Event[]): { text: string; strays: string[] } {
  const doc = parseDocument(text);
  const strays: string[] = [];
  const schema = seqAt(doc, doc, "schema");
  for (const event of events) {
    let object = named(schema, event.name);
    if (!object) {
      object = doc.createNode({ name: event.name }) as YAMLMap;
      schema.add(object);
    }
    // The event's type is where its data is: the partition it lands in.
    object.set("physicalName", event.type);
    object.set("physicalType", "object");
    if (event.title && !object.has("businessName")) object.set("businessName", event.title);
    if (event.summary && !object.has("description")) object.set("description", event.summary);
    properties(doc, seqAt(doc, object, "properties"), event.properties, event.name, strays);
  }
  for (const item of schema.items) {
    const name = isMap(item) ? String(item.get("name")) : "?";
    if (!events.some((event) => event.name === name)) strays.push(`${name} is not an event the AsyncAPI contract says the API publishes`);
  }
  return { text: doc.toString({ lineWidth: 0 }), strays };
}

function generate(): void {
  const events = published();
  if (!existsSync(CONTRACT) && events.length === 0) return console.log("data:generate - the API publishes no events, so there is nothing to describe");
  const made = !existsSync(CONTRACT);
  const { text, strays } = generated(made ? starter() : readFileSync(CONTRACT, "utf8"), events);
  writeFileSync(CONTRACT, text);
  console.log(`data:generate - ${CONTRACT} ${made ? "started" : "brought up to date"}: ${events.length} events, from the AsyncAPI contract`);
  for (const stray of strays) console.log(`  - ${stray}; remove it`);
  if (made) console.log("  The rest is the owner's to say: `task data:lint` and `task data:check` list what is missing.");
}

// --- Gate: agrees with the AsyncAPI contract, and says what infra/ reads -------

type Contract = {
  apiVersion?: string;
  version?: string;
  servers?: { server?: string; type?: string; location?: string; format?: string; delimiter?: string }[];
  slaProperties?: { property?: string; value?: unknown; unit?: string }[];
  schema?: { name?: string; physicalName?: string }[];
};
export const read = (text: string) => (parseDocument(text).toJS() ?? {}) as Contract;

/** What infra/data.tf and the tasks read from the contract; the same rules as the Terraform's. */
export function needs(contract: Contract): string[] {
  const problems: string[] = [];
  const production = contract.servers?.find((server) => server.server === "production");
  if (!production) problems.push("servers has no server named `production`: where the data is kept");
  else {
    if (production.type !== "s3") problems.push("the production server's type must be s3");
    if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/([a-z0-9_-]+\/)+$/.test(production.location ?? "")) {
      problems.push("the production server's location must be s3://<bucket>/<prefix>/ - lower case, ending in a slash; events land under it as type=<event type>/dt=<date>/");
    }
    if (production.format !== "json" || production.delimiter !== "new_line") problems.push("the production server must say format: json and delimiter: new_line - one event per line is what is written");
  }
  const sla = (property: string) => contract.slaProperties?.find((entry) => entry.property === property);
  const retention = sla("retention");
  if (!retention || !Number.isInteger(retention.value) || (retention.value as number) < 1 || !["d", "y"].includes(retention.unit ?? "")) {
    problems.push("slaProperties needs `property: retention` with a whole `value` and `unit: d` or `y`: how long the data is kept");
  }
  const latency = sla("latency");
  if (!latency || typeof latency.value !== "number" || latency.value <= 0 || !["s", "m", "h", "d"].includes(latency.unit ?? "")) {
    problems.push("slaProperties needs `property: latency` with a `value` and `unit: s`, `m`, `h` or `d`: how soon after it happens an event is there to read");
  }
  return problems;
}

function check(): void {
  if (!existsSync(CONTRACT)) return console.log(`data:check - no ${CONTRACT}, so the events this API publishes are not kept as data`);
  const text = readFileSync(CONTRACT, "utf8");
  const contract = read(text);
  const problems: string[] = [];
  if (contract.apiVersion !== ODCS) problems.push(`apiVersion is ${contract.apiVersion}; the template is on ODCS ${ODCS} (ODCS_VERSION in Taskfile.yml)`);
  const events = published();
  const { text: wanted, strays } = generated(text, events);
  problems.push(...strays);
  if (wanted !== text) problems.push("it differs from what the AsyncAPI contract says (an event, a property, a type or whether it is required) - run `task data:generate` and commit the result");
  problems.push(...needs(contract));
  if (problems.length > 0) stop([`data:check failed - ${CONTRACT}`, ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  console.log(`data:check ok - ODCS ${ODCS}, ${events.length} events described as the AsyncAPI contract has them`);
}

// --- Gate: a change is versioned ----------------------------------------------

const cli = (args: string[]) => {
  const version = process.env.DATACONTRACT_CLI_VERSION ?? stop("data: DATACONTRACT_CLI_VERSION is not set - run this through its task");
  return spawnSync("uvx", ["--from", `datacontract-cli[duckdb]==${version}`, "datacontract", ...args], { encoding: "utf8" });
};

function compat(): void {
  const skip = (why: string) => console.log(`data:compat skipped - ${why}`);
  if (!existsSync(CONTRACT)) return skip(`there is no ${CONTRACT}`);
  const ref = baseline();
  if (!ref) return skip("there is no earlier commit to compare with");
  const before = show(ref, CONTRACT);
  if (before === undefined) return skip(`${ref.slice(0, 12)} has no ${CONTRACT}, so there is nothing to break`);
  const now = readFileSync(CONTRACT, "utf8");
  const [old, current] = [read(before), read(now)];
  const from = `${old.version} (at ${ref.slice(0, 12)})`;
  if (before.trim() === now.trim()) return console.log(`data:compat ok - unchanged since ${from}`);

  const work = mkdtempSync(join(tmpdir(), "data-compat-"));
  let changes: { severity?: string; change?: string; path?: string; message?: string }[];
  try {
    writeFileSync(join(work, "before.yaml"), before);
    const run = cli(["changelog", join(work, "before.yaml"), CONTRACT, "--output-format", "json"]);
    if (run.status !== 0) stop(`data:compat failed - the Data Contract CLI could not compare the contracts\n${(run.stderr || run.stdout).trim()}`);
    const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as { entries?: typeof changes; changes?: typeof changes };
    changes = (report.entries ?? report.changes ?? []).filter((change) => change.path !== "version");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const breaking = changes.filter((change) => change.severity?.toLowerCase() === "error");

  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  const to = parse(current.version) ?? stop(`data:compat failed\n  - version "${current.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = to as [number, number, number];
  const [oldMajor, oldMinor, oldPatch] = (parse(old.version) ?? [0, 0, 0]) as [number, number, number];
  const bumped = {
    major: major > oldMajor,
    minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
    any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
  };
  const lines = changes.map((change) => `    ${change.severity?.toLowerCase() === "error" ? "breaking" : "        "}  ${change.change?.toLowerCase() ?? "changed"} ${change.path}${change.message ? ` - ${change.message}` : ""}`);
  const problems: string[] = [];
  if (breaking.length > 0 && !(bumped.major || (oldMajor === 0 && bumped.minor))) {
    problems.push(`the data contract has breaking changes but its version went from ${from} to ${current.version}; that needs a new ${oldMajor === 0 ? "minor version (the contract is still 0.x)" : "major version"}`);
  } else if (!bumped.any) {
    problems.push(`the data contract was edited but its version is still ${current.version}; every published edit needs a new version`);
  }
  if (problems.length > 0) stop(["data:compat failed", ...problems.map((problem) => `  - ${problem}`), ...lines].join("\n"));
  console.log([`data:compat ok - ${from} -> ${current.version}: ${breaking.length} breaking, ${changes.length - breaking.length} other changes`, ...lines].join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [command] = process.argv.slice(2);
    if (command === "generate") generate();
    else if (command === "check") check();
    else if (command === "compat") compat();
    else stop("data: generate | check | compat");
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
