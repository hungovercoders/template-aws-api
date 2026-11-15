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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  // ODCS reads `required` as never null, so a property that may be null is not required there, whatever JSON Schema says.
  const nullable = Array.isArray(schema.type) && schema.type.includes("null");
  const logicalType =
    type === "string" && schema.format === "date-time" ? "timestamp" : type === "string" && schema.format === "date" ? "date" : type && ["string", "integer", "number", "boolean", "object", "array"].includes(type) ? type : schema.properties ? "object" : "string";
  // What the type allows, where ODCS has a word for it - and only the words that type has.
  const allowed =
    logicalType === "string"
      ? { format: ["email", "uuid", "uri", "hostname", "ipv4", "ipv6", "password"].includes(schema.format ?? "") ? schema.format : undefined, minLength: schema.minLength, maxLength: schema.maxLength, pattern: schema.pattern }
      : logicalType === "integer" || logicalType === "number"
        ? { minimum: schema.minimum, maximum: schema.maximum }
        : {};
  const options = Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined));
  return {
    name,
    logicalType,
    required: required && !nullable,
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
  if (!contract.servers?.some((server) => server.server === "production")) problems.push("servers has no server named `production`: where the data is kept");
  // Every server is a stack's bucket (`-var data_server=<name>`), so each is held to what the Terraform reads.
  for (const server of contract.servers ?? []) {
    const name = `the ${server.server ?? "unnamed"} server`;
    if (server.type !== "s3") problems.push(`${name}'s type must be s3`);
    if (!/^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\/([a-z0-9_-]+\/)+$/.test(server.location ?? "")) {
      problems.push(`${name}'s location must be s3://<bucket>/<prefix>/ - lower case, ending in a slash; events land under it as type=<event type>/dt=<date>/`);
    }
    if (server.format !== "json" || server.delimiter !== "new_line") problems.push(`${name} must say format: json and delimiter: new_line - one event per line is what is written`);
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

  // The Data Contract CLI says what changed (changelog) and whether a reader of the data would break (breaking).
  const work = mkdtempSync(join(tmpdir(), "data-compat-"));
  let changes: { type?: string; path?: string }[];
  let breaking: boolean;
  let verdict: string;
  try {
    writeFileSync(join(work, "before.yaml"), before);
    const log = cli(["changelog", join(work, "before.yaml"), CONTRACT, "--output-format", "json"]);
    const start = log.stdout.indexOf("{");
    if (log.status !== 0 || start < 0) stop(`data:compat failed - the Data Contract CLI could not compare the contracts\n${(log.stderr || log.stdout).trim()}`);
    const report = JSON.parse(log.stdout.slice(start)) as { summary?: typeof changes };
    if (!Array.isArray(report.summary)) stop("data:compat failed - the Data Contract CLI's changelog is not in the form this gate reads (no `summary`); the pinned version changed it");
    changes = report.summary!.filter((change) => change.path !== "version");
    // It exits 0 when no reader breaks and 1 when one would; anything else is the CLI failing.
    const judged = cli(["breaking", join(work, "before.yaml"), CONTRACT]);
    if (judged.status !== 0 && judged.status !== 1) stop(`data:compat failed - the Data Contract CLI could not judge the change\n${(judged.stderr || judged.stdout).trim()}`);
    breaking = judged.status === 1;
    verdict = judged.stdout.trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  const to = parse(current.version) ?? stop(`data:compat failed\n  - version "${current.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = to as [number, number, number];
  const [oldMajor, oldMinor, oldPatch] = (parse(old.version) ?? [0, 0, 0]) as [number, number, number];
  const bumped = {
    major: major > oldMajor,
    minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
    any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
  };
  const lines = changes.map((change) => `    ${change.type ?? "changed"} ${change.path}`);
  const problems: string[] = [];
  if (breaking && !(bumped.major || (oldMajor === 0 && bumped.minor))) {
    problems.push(`the data contract has breaking changes but its version went from ${from} to ${current.version}; that needs a new ${oldMajor === 0 ? "minor version (the contract is still 0.x)" : "major version"}`);
  } else if (!bumped.any) {
    problems.push(`the data contract was edited but its version is still ${current.version}; every published edit needs a new version`);
  }
  if (problems.length > 0) stop(["data:compat failed", ...problems.map((problem) => `  - ${problem}`), ...(breaking ? [verdict] : lines)].join("\n"));
  console.log([`data:compat ok - ${from} -> ${current.version}: ${breaking ? "breaking" : "nothing breaking"}, ${changes.length} changes`, ...lines].join("\n"));
}

// Run as a script, wherever the checkout is and however it was reached - not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
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
