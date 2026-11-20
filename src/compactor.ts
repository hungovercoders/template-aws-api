// The daily compaction of the events kept as data, run by its schedule
// (infra/data.tf) and by `task data:compact`. For each live major of the data
// contract and each event type, the last few days' raw JSON becomes one
// Parquet file per day (src/lib/compactor.ts).
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import layout from "./generated/data.json" with { type: "json" };
import { compact, type SchemaObject, window } from "./lib/compactor.ts";
import { createLogger } from "./lib/log.ts";

/** Where each major's data is in the bucket, from the stack's data contract server (infra/data.tf). */
type Locations = Record<string, { raw: string; parquet: string }>;
/** What a run is asked: today too (a test, or by hand), and how many whole days back. */
type Request = { includeToday?: boolean; lookbackDays?: number };

const s3 = new S3Client({ forcePathStyle: Boolean(process.env.AWS_ENDPOINT_URL) });

async function keys(bucket: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    found.push(...(page.Contents ?? []).map((object) => object.Key!).filter(Boolean));
    token = page.NextContinuationToken;
  } while (token);
  return found;
}

async function text(bucket: string, key: string): Promise<string> {
  const body = await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray();
  if (!key.endsWith(".gz")) return new TextDecoder().decode(body);
  const { gunzipSync } = await import("node:zlib");
  return new TextDecoder().decode(gunzipSync(body));
}

export async function handler(request: Request = {}) {
  const log = createLogger({ job: "data-compaction" });
  const bucket = process.env.DATA_BUCKET!;
  const locations = JSON.parse(process.env.DATA_LOCATIONS ?? "{}") as Locations;
  const lookback = request.lookbackDays ?? Number(process.env.LOOKBACK_DAYS ?? 3);
  // An event lands on the day it arrived, which can be the day after it happened.
  const days = window(new Date(), lookback, request.includeToday === true);
  const arrived = [...days, ...window(new Date(), 0, true)];
  const written: { major: string; type: string; day: string; events: number }[] = [];
  let rejected = 0;
  for (const [major, where] of Object.entries(locations)) {
    for (const object of ((layout as Record<string, SchemaObject[]>)[major] ?? []) as SchemaObject[]) {
      const files = (await Promise.all([...new Set(arrived)].map((day) => keys(bucket, `${where.raw}type=${object.physicalName}/dt=${day}/`)))).flat();
      if (files.length === 0) continue;
      const lines = (await Promise.all(files.map((key) => text(bucket, key)))).flatMap((content) => content.split("\n"));
      const result = compact(object, lines, new Set(days));
      for (const reason of result.rejected) log.error("event not compacted", { major, type: object.physicalName, event_id: reason.id, reason: reason.reason });
      rejected += result.rejected.length;
      for (const file of result.files) {
        const key = `${where.parquet}type=${object.physicalName}/dt=${file.day}/events.parquet`;
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: file.parquet, ContentType: "application/vnd.apache.parquet" }));
        written.push({ major, type: object.physicalName, day: file.day, events: file.events });
      }
    }
  }
  log.info("compacted", { days, files: written.length, events: written.reduce((sum, file) => sum + file.events, 0), rejected });
  return { days, written, rejected };
}
