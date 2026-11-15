// The events the API publishes, at rest in S3, from the command line.
//   node local/data.ts test          - gate: the data that landed keeps the data contract (schema and quality rules)
//   node local/data.ts query [sql]   - run SQL over the data with DuckDB, a view per event already defined; no SQL opens its shell
//   node local/data.ts browse        - the same views in Harlequin
// ENV=local (the default) is the local stack on AWS Emulator; ENV=aws is the
// deployed stack, with your AWS credentials.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseDocument } from "yaml";
import { stackOutputs } from "./outputs.ts";

const CONTRACT = "specs/datacontract.yaml";
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const where = process.env.ENV ?? "local";
// An API that keeps no data has nothing to test; asking to read it is a mistake.
if (!existsSync(CONTRACT)) {
  if (process.argv[2] !== "test") fail(`data: there is no ${CONTRACT}, so the events this API publishes are not kept as data`);
  console.log(`data:test - no ${CONTRACT}, so the events this API publishes are not kept as data`);
  process.exit(0);
}
// Inside `task acceptance` the stack's outputs are already in the environment.
const inAcceptance = Boolean(process.env.DATA_BUCKET) && where === "local";
const outputs = inAcceptance ? { data_bucket: process.env.DATA_BUCKET, data_prefix: process.env.DATA_PREFIX } : stackOutputs("data");
const bucket = outputs.data_bucket || fail(`data: the stack has no bucket for the data - it was applied before ${CONTRACT} was written. Apply it again (locally: restart \`task dev\`)`);
const prefix = outputs.data_prefix ?? "";
const emulator = process.env.AWS_ENDPOINT_URL;
// The emulator has no host name for a bucket.
const s3 = new S3Client(emulator ? { forcePathStyle: true } : {});

type SchemaObject = { name: string; physicalName?: string };
const schemas = ((parseDocument(readFileSync(CONTRACT, "utf8")).toJS() as { schema?: SchemaObject[] }).schema ?? []).filter((object) => object.physicalName);
/** Where the copy of the data is kept, as one JSON document per line, by event and day. */
const copy = resolve(".local", "data", where);
const UNDESCRIBED = "_undescribed";

type Stored = { key: string; type: string; day: string };
/** Everything under the prefix that is an event: <prefix>type=<event type>/dt=<day>/<file>. */
async function stored(): Promise<Stored[]> {
  const found: Stored[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      const match = /type=([^/]+)\/dt=([^/]+)\/[^/]+$/.exec(object.Key ?? "");
      if (match) found.push({ key: object.Key!, type: match[1]!, day: match[2]! });
    }
    token = page.NextContinuationToken;
  } while (token);
  return found;
}

/**
 * Bring the copy up to date: each object unzipped to <copy>/<event>/dt=<day>/<file>.json.
 * `days` keeps it to the most recent days. Returns the id of every event in the copy.
 */
async function sync(days?: number): Promise<Set<string>> {
  const since = days ? new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) : "";
  const ids = new Set<string>();
  for (const object of (await stored()).filter((candidate) => candidate.day >= since)) {
    const name = schemas.find((candidate) => candidate.physicalName === object.type)?.name ?? UNDESCRIBED;
    const file = join(copy, name, `dt=${object.day}`, `${object.key.split("/").pop()!.replace(/\.gz$/, "")}.json`);
    if (!existsSync(file)) {
      const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.key }))).Body!.transformToByteArray();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, object.key.endsWith(".gz") ? gunzipSync(body) : body);
    }
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        ids.add(String((JSON.parse(line) as { id?: unknown }).id));
      } catch {
        // Not JSON: the contract test will say so.
      }
    }
  }
  return ids;
}

const files = (name: string) =>
  existsSync(join(copy, name))
    ? readdirSync(join(copy, name), { recursive: true })
        .map(String)
        .filter((file) => file.endsWith(".json"))
    : [];

async function test(): Promise<void> {
  rmSync(copy, { recursive: true, force: true });
  // What the scenarios published (steps/events.ts): the data is complete when each of them has landed.
  const expected: string[] = inAcceptance && existsSync(".local/event-ids-published.json") ? JSON.parse(readFileSync(".local/event-ids-published.json", "utf8")) : [];
  const days = where === "aws" ? Number(process.env.DATA_DAYS ?? 2) : undefined;
  let ids = await sync(days);
  for (const deadline = Date.now() + 60_000; expected.some((id) => !ids.has(id)) && Date.now() < deadline; ) {
    await new Promise((done) => setTimeout(done, 1_000));
    ids = await sync(days);
  }
  const problems: string[] = [];
  const missing = expected.filter((id) => !ids.has(id));
  if (missing.length > 0) problems.push(`${missing.length} of the ${expected.length} events the scenarios published never landed in s3://${bucket}/${prefix} (the first: ${missing[0]})`);
  if (files(UNDESCRIBED).length > 0) problems.push(`events landed of a type the data contract does not describe: ${files(UNDESCRIBED).length} files, kept in ${join(copy, UNDESCRIBED)}`);
  const withData = schemas.filter((object) => files(object.name).length > 0);
  const without = schemas.filter((object) => !withData.includes(object));
  // The scenarios publish every event (publish:check), so after them none may be missing. Any other time a quiet event is not a fault.
  if (inAcceptance && expected.length > 0) problems.push(...without.map((object) => `no ${object.name} event landed, so its part of the contract was not tested`));
  if (problems.length > 0) fail(["data:test failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  if (withData.length === 0) return console.log(`data:test - nothing has landed in s3://${bucket}/${prefix}${days ? ` in the last ${days} days` : ""}, so there is nothing to test`);

  // The contract as written, pointed at the copy and limited to the events that have data.
  const doc = parseDocument(readFileSync(CONTRACT, "utf8"));
  doc.set("servers", [{ server: "copy", type: "local", path: `${copy}/{model}/*/*.json`, format: "json", delimiter: "new_line" }]);
  const contract = doc.toJS() as { schema: SchemaObject[] };
  doc.set(
    "schema",
    contract.schema
      .filter((object) => withData.some((kept) => kept.name === object.name))
      // The copy is laid out by the object's name; the CLI would look for it by physicalName.
      .map((object) => ({ ...object, physicalName: object.name })),
  );
  const file = resolve(".local", "datacontract.test.yaml");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  const version = process.env.DATACONTRACT_CLI_VERSION ?? fail("data: DATACONTRACT_CLI_VERSION is not set - run this through `task data:test`");
  const run = spawnSync("uvx", ["--from", `datacontract-cli[duckdb]==${version}`, "datacontract", "test", file, "--server", "copy"], { stdio: "inherit" });
  if (run.status !== 0) fail(`data:test failed - the data in s3://${bucket}/${prefix} does not keep ${CONTRACT} (above). The copy that was tested is in ${copy}`);
  console.log(`data:test ok - ${ids.size} events in s3://${bucket}/${prefix} keep the data contract${without.length > 0 ? `; no data yet for ${without.map((object) => object.name).join(", ")}` : ""}`);
}

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * A DuckDB script that defines a view for every event that has data. Returns its path.
 * `canReadS3` says whether the DuckDB that will run it can load its httpfs extension.
 */
async function views(canReadS3: boolean): Promise<string> {
  const lines: string[] = [];
  const present = new Set((await stored()).map((object) => object.type));
  let source: (object: SchemaObject) => string;
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
    source = (object) => `read_json(${quote(`s3://${bucket}/${prefix}type=${object.physicalName}/*/*`)}, format='newline_delimited', compression='gzip', hive_partitioning=true, union_by_name=true)`;
  } else {
    // Where it cannot be downloaded (a proxy that only passes HTTPS), the data is copied here and read from disk.
    console.error(`data: DuckDB could not install its httpfs extension here, so the data is copied to ${copy} and read from there.`);
    await sync(where === "aws" ? Number(process.env.DATA_DAYS ?? 30) : undefined);
    source = (object) => `read_json(${quote(`${copy}/${object.name}/*/*.json`)}, format='newline_delimited', hive_partitioning=true, union_by_name=true)`;
  }
  const defined: string[] = [];
  for (const object of schemas) {
    if (!present.has(object.physicalName!)) continue;
    // An event is delivered at least once, so it can be stored twice: a view shows each once.
    lines.push(`CREATE OR REPLACE VIEW ${object.name} AS SELECT * REPLACE (CAST("time" AS TIMESTAMPTZ) AS "time") FROM ${source(object)} QUALIFY row_number() OVER (PARTITION BY id ORDER BY "time") = 1;`);
    defined.push(object.name);
  }
  const quiet = schemas.filter((object) => !defined.includes(object.name)).map((object) => object.name);
  console.error(`data: ${defined.length > 0 ? `views ${defined.join(", ")}` : "no views"} over s3://${bucket}/${prefix}${quiet.length > 0 ? `; nothing has landed yet for ${quiet.join(", ")}` : ""}`);
  const file = resolve(".local", `data-${where}.sql`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  // It holds the credentials the views read with.
  chmodSync(file, 0o600);
  return file;
}

// DuckDB's own command line, and the DuckDB inside Harlequin, at the one version the Taskfile pins: they share extensions.
const duckdbVersion = () => process.env.DUCKDB_VERSION ?? fail("data: DUCKDB_VERSION is not set - run this through its task");
const duckdb = (args: string[], inherit = false) => spawnSync("uvx", ["--from", `duckdb-cli==${duckdbVersion()}`, "duckdb", ...args], inherit ? { stdio: "inherit" } : { encoding: "utf8" });
const canReadS3 = () => duckdb(["-c", "INSTALL httpfs; LOAD httpfs;"]).status === 0;

const [command, ...rest] = process.argv.slice(2);
if (command === "test") await test();
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
} else fail("data: test | query [sql] | browse");
