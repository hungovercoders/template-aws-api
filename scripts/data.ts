// The data contracts (specs/datacontract.v<N>.yaml, one for each live major):
// what the events this API publishes are once they have landed in S3 - an Open
// Data Contract Standard document, with a schema object for every event. Every
// live major receives every event, under its own location (ending /v<N>/), so
// a new major's readers and an old one's are served side by side.
//   node scripts/data.ts generate   - write into the contract what follows from the AsyncAPI contract: a schema
//                                     object for every event it publishes, each property's type and whether it
//                                     is required. What a person wrote (owner, classification, quality) is kept
//   node scripts/data.ts check      - gate: the contract is of the pinned ODCS version, agrees with the AsyncAPI
//                                     contract, and says what the infrastructure needs (where, how long, how fresh)
//   node scripts/data.ts compat     - gate: changes since the last published contract are listed, and its
//                                     version is bumped to match (breaking needs a major)
//   node scripts/data.ts layout     - src/generated/data.json: each live major's schema objects, for the
//                                     compactor to type its Parquet by (task generate runs it)
// The Data Contract CLI does the rest: `task data:lint` (valid ODCS) and
// `task data:test` (the data that landed keeps the contract).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { atBaseline, type Contract as File, contracts, datacontractNameProblems, misnamed, retired, versionProblems } from "./contracts.ts";
import { merged, type Schema } from "./sample.ts";
import { baseline } from "./spec-baseline.ts";

/** How the contracts are named in what this says. */
export const CONTRACT = "specs/datacontract.v<N>.yaml";
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
  return [`apiVersion: ${ODCS}`, "kind: DataContract", `id: ${slug(name)}-events-v0`, `name: ${name} events`, "version: 0.1.0", "status: draft", ""].join("\n");
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
  const files = contracts("datacontract");
  if (files.length === 0 && events.length === 0) return console.log("data:generate - the API publishes no events, so there is nothing to describe");
  // Every live major describes every event; with none yet, major 0 is started.
  const made = files.length === 0;
  for (const path of made ? ["specs/datacontract.v0.yaml"] : files.map((file) => file.path)) {
    const { text, strays } = generated(made ? starter() : readFileSync(path, "utf8"), events);
    writeFileSync(path, text);
    console.log(`data:generate - ${path} ${made ? "started" : "brought up to date"}: ${events.length} events, from the AsyncAPI contract`);
    for (const stray of strays) console.log(`  - ${stray}; remove it`);
  }
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
  const LOCATION = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(([a-z0-9_-]+\/)+)$/;
  const servers = contract.servers ?? [];
  // Every server is a stack's bucket (`-var data_server=<name>`), so each is held to what the Terraform reads;
  // beside it, <name>-parquet is where the compactor writes each day as Parquet.
  for (const server of servers) {
    const name = `the ${server.server ?? "unnamed"} server`;
    const parquet = server.server?.endsWith("-parquet") ?? false;
    if (server.type !== "s3") problems.push(`${name}'s type must be s3`);
    if (!LOCATION.test(server.location ?? "")) {
      problems.push(`${name}'s location must be s3://<bucket>/<prefix>/ - lower case, ending in a slash; events land under it as type=<event type>/dt=<date>/`);
    }
    if (parquet) {
      if (server.format !== "parquet") problems.push(`${name} must say format: parquet - the compactor writes one Parquet file per event type and day`);
      continue;
    }
    if (server.format !== "json" || server.delimiter !== "new_line") problems.push(`${name} must say format: json and delimiter: new_line - one event per line is what is written`);
    const twin = servers.find((candidate) => candidate.server === `${server.server}-parquet`);
    if (!twin) {
      problems.push(`${name} has no ${server.server}-parquet server beside it: where the compactor writes each day as Parquet (type: s3, format: parquet, the same bucket, a prefix of its own)`);
      continue;
    }
    const [raw, curated] = [LOCATION.exec(server.location ?? ""), LOCATION.exec(twin.location ?? "")];
    if (raw && curated && raw[1] !== curated[1]) problems.push(`the ${twin.server} server is in bucket ${curated[1]}, not ${raw[1]}: the Parquet is kept beside the raw JSON`);
    if (raw && curated && (raw[2]!.startsWith(curated[2]!) || curated[2]!.startsWith(raw[2]!))) problems.push(`the ${twin.server} server's prefix overlaps ${name}'s: each needs a prefix of its own`);
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
  const files = contracts("datacontract");
  const wrong = misnamed("datacontract");
  if (files.length === 0 && wrong.length === 0) return console.log(`data:check - no ${CONTRACT}, so the events this API publishes are not kept as data`);
  const problems: string[] = [...wrong];
  const events = published();
  const buckets = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readFileSync(file.path, "utf8");
    const contract = read(text);
    const own: string[] = [...versionProblems(file, contract), ...datacontractNameProblems(file, contract)];
    if (contract.apiVersion !== ODCS) own.push(`apiVersion is ${contract.apiVersion}; the template is on ODCS ${ODCS} (ODCS_VERSION in Taskfile.yml)`);
    const { text: wanted, strays } = generated(text, events);
    own.push(...strays);
    if (wanted !== text) own.push("it differs from what the AsyncAPI contract says (an event, a property, a type or whether it is required) - run `task data:generate` and commit the result");
    own.push(...needs(contract));
    problems.push(...own.map((problem) => (problem.startsWith(file.path) ? problem : `${file.path}: ${problem}`)));
    for (const server of contract.servers ?? []) {
      const bucket = /^s3:\/\/([^/]+)\//.exec(server.location ?? "")?.[1];
      if (bucket && server.server) buckets.set(server.server, new Set([...(buckets.get(server.server) ?? []), bucket]));
    }
  }
  // One stack keeps every major's data in one bucket, each under its own prefix.
  for (const [server, names] of buckets) {
    if (names.size > 1) problems.push(`the ${server} server is in more than one bucket (${[...names].join(", ")}); every major keeps its data in the same bucket, under its own /v<N>/ prefix`);
  }
  if (problems.length > 0) stop(["data:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  console.log(`data:check ok - ODCS ${ODCS}, ${files.map((file) => `v${file.major}`).join(" and ")}: ${events.length} events described as the AsyncAPI contract has them`);
}

// --- Gate: a change is versioned ----------------------------------------------

const cli = (args: string[]) => {
  const version = process.env.DATACONTRACT_CLI_VERSION ?? stop("data: DATACONTRACT_CLI_VERSION is not set - run this through its task");
  return spawnSync("uvx", ["--from", `datacontract-cli[duckdb]==${version}`, "datacontract", ...args], { encoding: "utf8" });
};

function compat(): void {
  const ref = baseline();
  if (!ref) return console.log("data:compat skipped - there is no earlier commit to compare with");
  const short = ref.slice(0, 12);
  const problems: string[] = [];
  const report: string[] = [];
  for (const file of contracts("datacontract")) compareOne(file, ref, problems, report);
  const { gone, problems: unannounced } = retired("datacontract", ref);
  problems.push(...unannounced);
  report.push(...gone.filter((file) => !unannounced.some((problem) => problem.startsWith(file.path))).map((file) => `  v${file.major} (${file.path}): retired - it was published deprecated`));
  if (problems.length > 0) stop(["data:compat failed", ...problems.map((problem) => `  - ${problem}`), ...report].join("\n"));
  console.log([`data:compat ok - compared with ${short}`, ...report].join("\n"));
}

function compareOne(file: File, ref: string, problems: string[], report: string[]): void {
  const label = `v${file.major} (${file.path})`;
  const before = atBaseline(file, ref);
  if (before === undefined) return void report.push(`  ${label}: new since ${ref.slice(0, 12)} - a new major has nothing published to break`);
  const now = readFileSync(file.path, "utf8");
  const [old, current] = [read(before), read(now)];
  const from = `${old.version} (at ${ref.slice(0, 12)})`;
  if (before.trim() === now.trim()) return void report.push(`  ${label}: unchanged since ${from}`);

  // The Data Contract CLI says what changed (changelog) and whether a reader of the data would break (breaking).
  const work = mkdtempSync(join(tmpdir(), "data-compat-"));
  let changes: { type?: string; path?: string }[];
  let breaking: boolean;
  let verdict: string;
  try {
    writeFileSync(join(work, "before.yaml"), before);
    const log = cli(["changelog", join(work, "before.yaml"), file.path, "--output-format", "json"]);
    const start = log.stdout.indexOf("{");
    if (log.status !== 0 || start < 0) stop(`data:compat failed - the Data Contract CLI could not compare ${file.path}\n${(log.stderr || log.stdout).trim()}`);
    const summary = (JSON.parse(log.stdout.slice(start)) as { summary?: typeof changes }).summary;
    if (!Array.isArray(summary)) stop("data:compat failed - the Data Contract CLI's changelog is not in the form this gate reads (no `summary`); the pinned version changed it");
    changes = summary!.filter((change) => change.path !== "version");
    // It exits 0 when no reader breaks and 1 when one would; anything else is the CLI failing.
    const judged = cli(["breaking", join(work, "before.yaml"), file.path]);
    if (judged.status !== 0 && judged.status !== 1) stop(`data:compat failed - the Data Contract CLI could not judge the change to ${file.path}\n${(judged.stderr || judged.stdout).trim()}`);
    breaking = judged.status === 1;
    verdict = judged.stdout.trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
  const to = parse(current.version);
  if (!to) return void problems.push(`${file.path}: version "${current.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = to as [number, number, number];
  const [oldMajor, oldMinor, oldPatch] = (parse(old.version) ?? [0, 0, 0]) as [number, number, number];
  const bumped = {
    minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
    any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
  };
  const lines = changes.map((change) => `      ${change.type ?? "changed"} ${change.path}`);
  const before_ = problems.length;
  if (breaking && !(oldMajor === 0 && bumped.minor)) {
    problems.push(
      oldMajor === 0
        ? `${file.path} has breaking changes but its version went from ${from} to ${current.version}; while the contract is 0.x that needs a new minor version`
        : `${file.path} has breaking changes: v${file.major}'s readers would fail. Make the change in specs/datacontract.v${file.major + 1}.yaml, whose data lands beside this one's, and leave v${file.major} as it is`,
    );
  } else if (!bumped.any) {
    problems.push(`${file.path} was edited but its version is still ${current.version}; every published edit needs a new version`);
  }
  report.push(`  ${label}: ${from} -> ${current.version}: ${breaking ? "breaking" : "nothing breaking"}, ${changes.length} changes`, ...(problems.length > before_ && breaking ? [verdict] : lines));
}

// --- Generated: what the compactor types its Parquet by -------------------------

type Described = { name?: string; logicalType?: string; required?: boolean; properties?: Described[]; items?: Described };
const described = (property: Described): Described => ({
  ...(property.name === undefined ? {} : { name: property.name }),
  ...(property.logicalType === undefined ? {} : { logicalType: property.logicalType }),
  ...(property.required ? { required: true } : {}),
  ...(property.properties ? { properties: property.properties.map(described) } : {}),
  ...(property.items ? { items: described(property.items) } : {}),
});

/** Each live major's schema objects: their names, their event types and how each property is typed. */
export function layout(texts: Record<string, string>): Record<string, { name: string; physicalName: string; properties: Described[] }[]> {
  return Object.fromEntries(
    Object.entries(texts).map(([major, text]) => {
      const contract = parseDocument(text).toJS() as { schema?: (Described & { physicalName?: string })[] };
      const objects = (contract?.schema ?? []).filter((object) => object.name && object.physicalName);
      return [major, objects.map((object) => ({ name: object.name!, physicalName: object.physicalName!, properties: (object.properties ?? []).map(described) }))];
    }),
  );
}

function writeLayout(): void {
  const texts = Object.fromEntries(contracts("datacontract").map((file) => [`v${file.major}`, readFileSync(file.path, "utf8")]));
  mkdirSync("src/generated", { recursive: true });
  writeFileSync("src/generated/data.json", JSON.stringify(layout(texts), null, 2) + "\n");
  console.log(`generated src/generated/data.json - ${Object.keys(texts).length} data contract majors`);
}

// Run as a script, wherever the checkout is and however it was reached - not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [command] = process.argv.slice(2);
    if (command === "generate") generate();
    else if (command === "check") check();
    else if (command === "compat") compat();
    else if (command === "layout") writeLayout();
    else stop("data: generate | check | compat | layout");
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
