// The events the API publishes, at rest in S3, from the command line.
//   node local/data.ts test          - gate: the data that landed keeps the data contract (schema and quality rules)
//   node local/data.ts query [sql]   - run SQL over the data with DuckDB, a view per event already defined; no SQL opens its shell
//   node local/data.ts browse        - the same views in Harlequin
//   node local/data.ts compact       - compact the raw JSON into Parquet now, as the daily schedule does
// ENV=local (the default) is the local stack on AWS Emulator; ENV=aws is the
// deployed stack, with your AWS credentials. Each live major of the data
// contract (specs/datacontract.v<N>.yaml) keeps its data under a prefix of its
// own: `test` tests every one; `query` and `browse` read the newest, or the one
// DATA_MAJOR names (DATA_MAJOR=v1).
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import { parquetSchema, type Property, recentDays } from "../src/lib/compactor.ts";
import { parseDocument } from "yaml";
import { contracts } from "../scripts/contracts.ts";
import { stackOutputs } from "./outputs.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const where = process.env.ENV ?? "local";
const majors = contracts("datacontract");
// An API that keeps no data has nothing to test; asking to read it is a mistake.
if (majors.length === 0) {
  if (process.argv[2] !== "test") fail("data: there is no specs/datacontract.v<N>.yaml, so the events this API publishes are not kept as data");
  console.log("data:test - no specs/datacontract.v<N>.yaml, so the events this API publishes are not kept as data");
  process.exit(0);
}
// Every major is tested, each in a run of its own.
if (process.argv[2] === "test" && !process.env.DATA_MAJOR && majors.length > 1) {
  for (const { major } of majors) {
    const run = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit", env: { ...process.env, DATA_MAJOR: `v${major}` } });
    if (run.status !== 0) process.exit(run.status ?? 1);
  }
  process.exit(0);
}
const chosen = process.env.DATA_MAJOR
  ? (majors.find(({ major }) => `v${major}` === process.env.DATA_MAJOR) ?? fail(`data: DATA_MAJOR is ${process.env.DATA_MAJOR}, which is not a live major (${majors.map(({ major }) => `v${major}`).join(", ")})`))
  : majors.at(-1)!;
const CONTRACT = chosen.path;
// Inside `task acceptance` the stack's outputs are already in the environment.
const inAcceptance = Boolean(process.env.DATA_BUCKET) && where === "local";
const outputs = inAcceptance
  ? {
      data_bucket: process.env.DATA_BUCKET,
      data_prefixes: process.env.DATA_PREFIXES,
      data_parquet_prefixes: process.env.DATA_PARQUET_PREFIXES,
      data_compactor: process.env.DATA_COMPACTOR,
      data_compression: process.env.DATA_COMPRESSION,
    }
  : stackOutputs("data");
const bucket = outputs.data_bucket || fail(`data: the stack has no bucket for the data - it was applied before ${CONTRACT} was written. Apply it again (locally: restart \`task dev\`)`);
const prefix =
  (JSON.parse(outputs.data_prefixes || "{}") as Record<string, string>)[`v${chosen.major}`] ??
  fail(`data: the stack keeps no data for ${CONTRACT} - it was applied before that major was written. Apply it again (locally: restart \`task dev\`)`);
const parquetPrefix =
  (JSON.parse(outputs.data_parquet_prefixes || "{}") as Record<string, string>)[`v${chosen.major}`] ??
  fail(`data: the stack has no Parquet for ${CONTRACT} - it was applied before the compaction to Parquet was. Apply it again (locally: restart \`task dev\`)`);
const emulator = process.env.AWS_ENDPOINT_URL;
// The emulator has no host name for a bucket.
const s3 = new S3Client(emulator ? { forcePathStyle: true } : {});

type SchemaObject = { name: string; physicalName?: string };
const schemas = ((parseDocument(readFileSync(CONTRACT, "utf8")).toJS() as { schema?: SchemaObject[] }).schema ?? []).filter((object) => object.physicalName);
const nameOf = (type: string) => schemas.find((candidate) => candidate.physicalName === type)?.name;

type Stored = { key: string; type: string; day: string };
/** Everything under a prefix that is an event, or a day's Parquet: <prefix>type=<event type>/dt=<day>/<file>. Names only; nothing is read. */
async function stored(under = prefix): Promise<Stored[]> {
  const found: Stored[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: under, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      const match = /type=([^/]+)\/dt=([^/]+)\/[^/]+$/.exec(object.Key ?? "");
      if (match) found.push({ key: object.Key!, type: match[1]!, day: match[2]! });
    }
    token = page.NextContinuationToken;
  } while (token);
  return found;
}

// The local stack's objects are the scenarios' own and small: one read serves both finding their ids and a copy.
const fetched = new Map<string, Buffer>();
const read = async (key: string) => {
  const kept = fetched.get(key);
  if (kept) return kept;
  const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray();
  const content = key.endsWith(".gz") ? gunzipSync(body) : Buffer.from(body);
  if (where === "local") fetched.set(key, content);
  return content;
};

/**
 * A copy of the data on this machine - only ever made when it cannot be read
 * where it is, and never kept: a private directory outside the repository,
 * removed when the task ends, however it ends.
 */
function temporary(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-")); // readable by this user alone
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(1));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function copyTo(dir: string, objects: Stored[]): Promise<void> {
  for (const object of objects) {
    const file = join(dir, nameOf(object.type) ?? "_undescribed", `dt=${object.day}`, `${object.key.split("/").pop()!.replace(/\.gz$/, "")}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await read(object.key), { mode: 0o600 });
  }
}
const REAL_DATA = `That would put a copy of real data on this machine. Read it where it is instead`;

async function test(): Promise<void> {
  // What an earlier version of this task kept here: a copy of the data. Nothing is kept any more.
  for (const old of [resolve(".local", "data"), resolve(".local", "datacontract.test.yaml")]) rmSync(old, { recursive: true, force: true });
  const given = process.env.DATA_DAYS ?? "2";
  if (where === "aws" && !/^[1-9]\d*$/.test(given)) fail(`data:test - DATA_DAYS is how many recent days of the deployed stack's data to test, a whole number from 1; it is "${given}"`);
  const days = where === "aws" ? Number(given) : undefined;
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  const recent = async () => (await stored()).filter((object) => object.day >= since);

  // What the scenarios published (steps/events.ts): the data is complete when each of them has landed.
  // They are the scenarios' own events, read here in memory to find their ids; nothing is written down.
  const expected: string[] = inAcceptance && existsSync(".local/event-ids-published.json") ? JSON.parse(readFileSync(".local/event-ids-published.json", "utf8")) : [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  let objects = await recent();
  for (const deadline = Date.now() + 60_000; expected.length > 0; ) {
    for (const object of objects.filter((candidate) => !seen.has(candidate.key))) {
      seen.add(object.key);
      for (const line of (await read(object.key)).toString("utf8").split("\n")) {
        try {
          if (line.trim()) ids.add(String((JSON.parse(line) as { id?: unknown }).id));
        } catch {
          // Not JSON: the contract test will say so.
        }
      }
    }
    if (expected.every((id) => ids.has(id)) || Date.now() > deadline) break;
    await new Promise((done) => setTimeout(done, 1_000));
    objects = await recent();
  }

  const problems: string[] = [];
  const missing = expected.filter((id) => !ids.has(id));
  if (missing.length > 0) problems.push(`${missing.length} of the ${expected.length} events the scenarios published never landed in s3://${bucket}/${prefix} (the first: ${missing[0]})`);
  const undescribed = [...new Set(objects.filter((object) => !nameOf(object.type)).map((object) => object.type))];
  if (undescribed.length > 0) problems.push(`events landed of a type the data contract does not describe: ${undescribed.join(", ")}`);
  const withData = schemas.filter((object) => objects.some((landed) => landed.type === object.physicalName));
  const without = schemas.filter((object) => !withData.includes(object));
  // The scenarios publish every event (publish:check), so after them none may be missing. Any other time a quiet event is not a fault.
  if (inAcceptance && expected.length > 0) problems.push(...without.map((object) => `no ${object.name} event landed, so its part of the contract was not tested`));
  if (problems.length > 0) fail(["data:test failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  if (withData.length === 0) return console.log(`data:test - nothing has landed in s3://${bucket}/${prefix}${days ? ` in the last ${days} days` : ""}, so there is nothing to test`);

  // Plain JSON is tested where it is. The Data Contract CLI cannot read a gzipped file, so those are unpacked first.
  const zippedDays = new Set(objects.filter((object) => object.key.endsWith(".gz")).map((object) => object.day));
  let copy: string | undefined;
  let skipped: string[] = [];
  if (zippedDays.size > 0 && (where !== "aws" || process.env.DATA_COPY === "yes")) {
    copy = temporary();
    await copyTo(copy, objects);
  } else if (zippedDays.size > 0) {
    const copyNote = "if this data may be on this machine for the length of the test: DATA_COPY=yes. The copy is private and is removed when the test ends.";
    const plainDays = [...new Set(objects.map((object) => object.day))].filter((day) => !zippedDays.has(day));
    if (outputs.data_compression === "GZIP" || plainDays.length === 0) {
      fail(
        [
          `data:test - the data in s3://${bucket}/${prefix} is gzipped, and the Data Contract CLI can only test gzipped data from an unpacked copy.`,
          `  ${REAL_DATA}: deploy with data_compression = UNCOMPRESSED${outputs.data_compression === "GZIP" ? "" : " (the stack already is; the gzipped files are from before, and age out of the days tested)"}.`,
          `  Or, ${copyNote}`,
        ].join("\n"),
      );
    }
    // A stack that used to write gzip: those days cannot be tested where they are, and are said, not hidden.
    skipped = [...zippedDays].sort();
    objects = objects.filter((object) => !zippedDays.has(object.day));
    console.log(`data:test - not tested: ${skipped.join(", ")}, which hold gzipped files from before the stack wrote plain JSON. To test them too, ${copyNote}`);
  }
  const tested = schemas.filter((object) => objects.some((landed) => landed.type === object.physicalName));

  // One contract for each event that has data: the contract as written, pointed at where that event's data is.
  const dir = resolve(".local", "datacontract.test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const contract = parseDocument(readFileSync(CONTRACT, "utf8")).toJS() as { schema: SchemaObject[] };
  // A deployed stack is tested on its recent days (DATA_DAYS says how many). The CLI reads one place at a
  // time, so each day's data is tested by itself: a rule about the whole (a repeated id) is held within a day.
  type Place = { object: SchemaObject; label: string; server: Record<string, string> };
  const places = tested.flatMap((object): Place[] => {
    if (copy) return [{ object, label: object.name, server: { type: "local", path: `${copy}/${object.name}/*/*.json` } }];
    const at = (day: string) => ({ type: "s3", location: `s3://${bucket}/${prefix}type=${object.physicalName}/${day}/*`, ...(emulator ? { endpointUrl: new URL(emulator).origin } : {}) });
    if (!days) return [{ object, label: object.name, server: at("*") }];
    const landed = [...new Set(objects.filter((candidate) => candidate.type === object.physicalName).map((candidate) => candidate.day))].sort();
    return landed.map((day) => ({ object, label: `${object.name}.${day}`, server: at(`dt=${day}`) }));
  });
  const contracts = places.map(({ object, label, server }) => {
    const doc = parseDocument(readFileSync(CONTRACT, "utf8"));
    doc.set("servers", [{ server: "data", ...server, format: "json", delimiter: "new_line" }]);
    // The CLI names the table it reads after physicalName; the place is already said.
    doc.set("schema", [{ ...contract.schema.find((candidate) => candidate.name === object.name)!, physicalName: object.name }]);
    const file = join(dir, `${label}.yaml`);
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
    return file;
  });
  const version = process.env.DATACONTRACT_CLI_VERSION ?? fail("data: DATACONTRACT_CLI_VERSION is not set - run this through `task data:test`");
  // The CLI finds the region as boto3 does, which does not read AWS_REGION.
  const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION;
  const env = { ...process.env, ...(region ? { AWS_DEFAULT_REGION: region } : {}) };
  const run = spawnSync("uvx", ["--from", `datacontract-cli[duckdb,s3]==${version}`, "python", "local/data_test.py", "data", ...contracts], { stdio: "inherit", env });
  if (run.status !== 0) fail(`data:test failed - the data in s3://${bucket}/${prefix} does not keep ${CONTRACT} (above)`);
  const how = copy ? "from an unpacked copy that has been removed" : "where it is";
  console.log(`data:test ok - the data in s3://${bucket}/${prefix} keeps the data contract, tested ${how}: ${tested.length} events' data${skipped.length > 0 ? ` (${skipped.length} days of gzipped data not tested)` : ""}${without.length > 0 ? `; none yet for ${without.map((object) => object.name).join(", ")}` : ""}`);
  await testParquet(expected, days, (contracts) => spawnSync("uvx", ["--from", `datacontract-cli[duckdb,s3]==${version}`, "python", "local/data_test.py", "data", ...contracts], { stdio: "inherit", env }).status === 0);
}

/** Run the compactor now, as its schedule does, today included. */
async function compactNow(): Promise<unknown> {
  const name = outputs.data_compactor || fail("data: the stack has no compactor - it was applied before the compaction to Parquet was. Apply it again (locally: restart `task dev`)");
  const lookbackDays = Number(process.env.DATA_DAYS ?? 3);
  const reply = await new LambdaClient({}).send(new InvokeCommand({ FunctionName: name, Payload: new TextEncoder().encode(JSON.stringify({ includeToday: true, lookbackDays })) }));
  const answer = reply.Payload ? new TextDecoder().decode(reply.Payload) : "";
  if (reply.FunctionError) fail(`data:compact failed - the compactor ${name} answered ${reply.FunctionError}: ${answer}`);
  return JSON.parse(answer || "{}");
}

/**
 * The Parquet keeps the contract too. In acceptance the compactor is run first,
 * and every event the scenarios published must be in it exactly once; on AWS the
 * last DATA_DAYS whole days are tested, which the schedule has compacted.
 */
async function testParquet(expected: string[], days: number | undefined, runCli: (contracts: string[]) => boolean): Promise<void> {
  if (inAcceptance) await compactNow();
  const today = new Date().toISOString().slice(0, 10);
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  const files = (await stored(parquetPrefix)).filter((file) => file.day >= since && (!days || file.day < today));
  const problems: string[] = [];
  if (inAcceptance && expected.length > 0) {
    const seen = new Map<string, number>();
    for (const file of files) {
      const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }))).Body!.transformToByteArray();
      const rows = (await parquetReadObjects({ file: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, columns: ["id"] })) as { id: string }[];
      for (const row of rows) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    }
    const missing = expected.filter((id) => !seen.has(id));
    const repeated = [...seen].filter(([, count]) => count > 1).map(([id]) => id);
    if (missing.length > 0) problems.push(`${missing.length} of the ${expected.length} events the scenarios published are not in the Parquet in s3://${bucket}/${parquetPrefix} (the first: ${missing[0]})`);
    if (repeated.length > 0) problems.push(`${repeated.length} events are in the Parquet more than once (the first: ${repeated[0]}): each should be there once`);
  }
  // The CLI cannot check a Parquet column's type yet: every file's schema is held to the one the contract gives.
  const typed = parseDocument(readFileSync(CONTRACT, "utf8")).toJS() as { schema?: { physicalName?: string; properties?: Property[] }[] };
  const columns = (elements: { name: string; type?: unknown; converted_type?: unknown; repetition_type?: unknown; num_children?: unknown }[]) =>
    elements.map(({ name, type, converted_type, repetition_type, num_children }) => JSON.stringify([name, type ?? null, converted_type ?? null, repetition_type ?? null, num_children ?? null]));
  for (const file of files) {
    const object = typed.schema?.find((candidate) => candidate.physicalName === file.type);
    if (!object) continue;
    const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: file.key }))).Body!.transformToByteArray();
    const written = parquetMetadata(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer).schema.slice(1);
    const wanted = parquetSchema(object.properties ?? []).slice(1) as never[];
    const [have, want] = [columns(written as never[]), columns(wanted)];
    if (have.join() !== want.join()) problems.push(`${file.key} is not typed as the contract says: columns ${have.filter((c) => !want.includes(c)).join(", ") || "(in another order)"} where it says ${want.filter((c) => !have.includes(c)).join(", ")}`);
  }
  const compacted = schemas.filter((object) => files.some((file) => file.type === object.physicalName));
  if (problems.length > 0) fail(["data:test failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  if (compacted.length === 0) return console.log(`data:test - nothing has been compacted into s3://${bucket}/${parquetPrefix}${days ? ` in the last ${days} whole days` : ""}, so there is no Parquet to test`);

  // One contract for each event type and place, as for the raw JSON, read as Parquet; and an id is there once.
  const dir = resolve(".local", "datacontract.test-parquet");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const contract = parseDocument(readFileSync(CONTRACT, "utf8")).toJS() as { schema: (SchemaObject & { properties?: { name: string; quality?: unknown[] }[] })[] };
  const at = (object: SchemaObject, day: string) => ({ type: "s3", location: `s3://${bucket}/${parquetPrefix}type=${object.physicalName}/${day}/*.parquet`, ...(emulator ? { endpointUrl: new URL(emulator).origin } : {}) });
  const places = compacted.flatMap((object) =>
    days
      ? [...new Set(files.filter((file) => file.type === object.physicalName).map((file) => file.day))].sort().map((day) => ({ object, label: `${object.name}.${day}`, server: at(object, `dt=${day}`) }))
      : [{ object, label: object.name, server: at(object, "*") }],
  );
  const contracts = places.map(({ object, label, server }) => {
    const doc = parseDocument(readFileSync(CONTRACT, "utf8"));
    doc.set("servers", [{ server: "data", ...server, format: "parquet" }]);
    const own = contract.schema.find((candidate) => candidate.name === object.name)!;
    const properties = (own.properties ?? []).map((property) => (property.name === "id" ? { ...property, quality: [...(property.quality ?? []), { metric: "duplicateValues", mustBe: 0 }] } : property));
    doc.set("schema", [{ ...own, physicalName: object.name, properties }]);
    const file = join(dir, `${label}.yaml`);
    writeFileSync(file, doc.toString({ lineWidth: 0 }));
    return file;
  });
  if (!runCli(contracts)) fail(`data:test failed - the Parquet in s3://${bucket}/${parquetPrefix} does not keep ${CONTRACT} (above)`);
  console.log(`data:test ok - the Parquet in s3://${bucket}/${parquetPrefix} keeps the data contract, each event once: ${compacted.length} events' data`);
}

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * A DuckDB script that defines a view for every event that has data. Returns its path.
 * `canReadS3` says whether the DuckDB that will run it can load its httpfs extension.
 */
async function views(canReadS3: boolean): Promise<string> {
  const lines: string[] = [];
  // The raw JSON is kept for years, so its views read only the last DATA_RAW_DAYS days (2): what the
  // daily compaction has not reached yet. Everything older is in the Parquet views.
  const given = process.env.DATA_RAW_DAYS ?? "2";
  if (!/^[1-9]\d*$/.test(given)) fail(`data: DATA_RAW_DAYS is how many recent days of raw JSON the <event>_raw views read, a whole number from 1; it is "${given}"`);
  const rawDays = recentDays(new Date(), Number(given));
  const objects = (await stored()).filter((object) => rawDays.includes(object.day));
  const present = new Set(objects.map((object) => object.type));
  const parquetFiles = await stored(parquetPrefix);
  const compactedTypes = new Set(parquetFiles.map((file) => file.type));
  let source: (object: SchemaObject) => string;
  let parquetSource: (object: SchemaObject) => string;
  // Reading S3 needs DuckDB's httpfs extension, which it downloads the first time.
  if (canReadS3) {
    const credentials = await defaultProvider()();
    const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
    lines.push("LOAD httpfs;");
    // DuckDB does not read AWS_CA_BUNDLE: it has to be told where the emulator's certificate is.
    if (emulator && process.env.AWS_CA_BUNDLE) lines.push(`SET ca_cert_file=${quote(process.env.AWS_CA_BUNDLE)};`);
    const at = emulator ? `, ENDPOINT ${quote(new URL(emulator).host)}, URL_STYLE 'path', USE_SSL ${emulator.startsWith("https")}` : "";
    const session = credentials.sessionToken ? `, SESSION_TOKEN ${quote(credentials.sessionToken)}` : "";
    lines.push(`CREATE OR REPLACE SECRET data (TYPE s3, KEY_ID ${quote(credentials.accessKeyId)}, SECRET ${quote(credentials.secretAccessKey)}${session}, REGION ${quote(region)}${at});`);
    // Plain or gzipped: DuckDB tells by the file's name.
    // Only the days that have data, each by its partition: a glob over every day would list years of files.
    const daysOf = (object: SchemaObject) => [...new Set(objects.filter((stored) => stored.type === object.physicalName).map((stored) => stored.day))].sort();
    source = (object) =>
      `read_json([${daysOf(object).map((day) => quote(`s3://${bucket}/${prefix}type=${object.physicalName}/dt=${day}/*`)).join(", ")}], format='newline_delimited', hive_partitioning=true, union_by_name=true)`;
    parquetSource = (object) => `read_parquet(${quote(`s3://${bucket}/${parquetPrefix}type=${object.physicalName}/*/*.parquet`)}, hive_partitioning=true)`;
  } else {
    // Where the extension cannot be downloaded (a proxy that only passes HTTPS), the data can only be read from a copy.
    if (where === "aws") {
      fail(`data: DuckDB could not install its httpfs extension here, which is what reads S3. ${REAL_DATA}: run this where DuckDB can reach extensions.duckdb.org, or install the extension by hand (https://duckdb.org/docs/stable/extensions/httpfs/overview).`);
    }
    const copy = temporary();
    console.error("data: DuckDB could not install its httpfs extension here, so the local stack's data is read from a copy that is removed when this ends.");
    await copyTo(copy, objects);
    source = (object) => `read_json(${quote(`${copy}/${object.name}/*/*.json`)}, format='newline_delimited', hive_partitioning=true, union_by_name=true)`;
    for (const file of parquetFiles) {
      const path = join(copy, "parquet", nameOf(file.type) ?? "_undescribed", `dt=${file.day}`, "events.parquet");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await read(file.key), { mode: 0o600 });
    }
    parquetSource = (object) => `read_parquet(${quote(`${copy}/parquet/${object.name}/*/*.parquet`)}, hive_partitioning=true)`;
  }
  const defined: string[] = [];
  for (const object of schemas) {
    if (!present.has(object.physicalName!)) continue;
    // An event is delivered at least once, so it can be stored twice: a view shows each once.
    lines.push(`CREATE OR REPLACE VIEW ${object.name}_raw AS SELECT * REPLACE (CAST("time" AS TIMESTAMPTZ) AS "time") FROM ${source(object)} QUALIFY row_number() OVER (PARTITION BY id ORDER BY "time") = 1;`);
    defined.push(`${object.name}_raw`);
  }
  // The days compacted to Parquet: typed by the contract, each event once already.
  for (const object of schemas) {
    if (!compactedTypes.has(object.physicalName!)) continue;
    lines.push(`CREATE OR REPLACE VIEW ${object.name} AS SELECT * FROM ${parquetSource(object)};`);
    defined.push(object.name);
  }
  const quiet = schemas.filter((object) => !defined.includes(object.name)).map((object) => object.name);
  console.error(
    `data: ${defined.length > 0 ? `views ${defined.join(", ")}` : "no views"} over s3://${bucket}/${prefix} (<event>_raw: the last ${given} days, DATA_RAW_DAYS widens it) and s3://${bucket}/${parquetPrefix} (<event>: every day compacted)${quiet.length > 0 ? `; no Parquet yet for ${quiet.join(", ")}` : ""}`,
  );
  const file = resolve(".local", `data-${where}.sql`);
  mkdirSync(dirname(file), { recursive: true });
  // It holds the credentials the views read with: readable by nobody else, and gone when the task ends,
  // however it ends - an interrupt meant for a query must not stop this before it has tidied up.
  rmSync(file, { force: true });
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) if (process.listenerCount(signal) === 0) process.on(signal, () => {});
  process.on("exit", () => rmSync(file, { force: true }));
  return file;
}

// DuckDB's own command line, and the DuckDB inside Harlequin, at the one version the Taskfile pins: they share extensions.
const duckdbVersion = () => process.env.DUCKDB_VERSION ?? fail("data: DUCKDB_VERSION is not set - run this through its task");
const duckdb = (args: string[], inherit = false) => spawnSync("uvx", ["--from", `duckdb-cli==${duckdbVersion()}`, "duckdb", ...args], inherit ? { stdio: "inherit" } : { encoding: "utf8" });
const canReadS3 = () => duckdb(["-c", "INSTALL httpfs; LOAD httpfs;"]).status === 0;

const [command, ...rest] = process.argv.slice(2);
if (command === "test") await test();
else if (command === "compact") console.log(`data:compact - ${JSON.stringify(await compactNow())}`);
else if (command === "query") {
  const init = await views(canReadS3());
  const sql = rest.join(" ").trim();
  const run = duckdb(["-init", init, ...(sql ? ["-c", sql] : [])], true);
  rmSync(init, { force: true });
  process.exit(run.status ?? 1);
} else if (command === "browse") {
  const version = process.env.HARLEQUIN_VERSION ?? fail("data: HARLEQUIN_VERSION is not set - run this through `task data:browse`");
  const init = await views(canReadS3());
  const run = spawnSync("uvx", ["--with", `duckdb==${duckdbVersion()}`, `harlequin==${version}`, "--init-path", init], { stdio: "inherit" });
  rmSync(init, { force: true });
  process.exit(run.status ?? 1);
} else fail("data: test | query [sql] | browse | compact");
