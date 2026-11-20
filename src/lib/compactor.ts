// The daily compaction of the events kept as data (infra/data.tf, the data
// component). Firehose writes each event as a line of JSON, under the day it
// arrived; this turns them into one Parquet file per event type and day:
//   <the major's parquet prefix>type=<event type>/dt=<the day it happened>/events.parquet
// typed by the data contract - a column per property, nested as the contract
// nests them - with each event once. Rewriting a day gives the same file, so
// running it again, or over days already done, is safe.
import { parquetWriteBuffer } from "hyparquet-writer";

/** A property of a schema object of the data contract, as `task generate` hands it on. */
export type Property = { name: string; logicalType?: string; required?: boolean; properties?: Property[]; items?: Omit<Property, "name"> };
/** A schema object: one event type. */
export type SchemaObject = { name: string; physicalName: string; properties: Property[] };

type Element = { name: string; [key: string]: unknown };

/** The Parquet schema for a schema object's properties. */
export function parquetSchema(properties: Property[]): Element[] {
  return [{ name: "root", num_children: properties.length }, ...properties.flatMap(column)];
}

function column(property: Property): Element[] {
  const repetition_type = property.required ? "REQUIRED" : "OPTIONAL";
  const name = property.name;
  switch (property.logicalType) {
    case "object": {
      const children = property.properties ?? [];
      // An object the contract does not describe inside is kept whole, as JSON.
      if (children.length === 0) return [{ name, type: "BYTE_ARRAY", converted_type: "JSON", repetition_type }];
      return [{ name, repetition_type, num_children: children.length }, ...children.flatMap(column)];
    }
    case "array":
      return [
        { name, repetition_type, converted_type: "LIST", num_children: 1 },
        { name: "list", repetition_type: "REPEATED", num_children: 1 },
        ...column({ logicalType: "string", ...property.items, name: "element", required: false }),
      ];
    case "integer":
      return [{ name, type: "INT64", repetition_type }];
    case "number":
      return [{ name, type: "DOUBLE", repetition_type }];
    case "boolean":
      return [{ name, type: "BOOLEAN", repetition_type }];
    case "timestamp":
      return [{ name, type: "INT64", converted_type: "TIMESTAMP_MILLIS", repetition_type }];
    case "date":
      return [{ name, type: "INT32", converted_type: "DATE", repetition_type }];
    default:
      return [{ name, type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type }];
  }
}

/** A value the contract's type cannot hold: the event is not written to Parquet, and is still in the raw JSON. */
export class Unplaceable extends Error {}

const DAY = 86_400_000;

/** A value as its column holds it. */
export function valueOf(property: Property, value: unknown): unknown {
  if (value === undefined || value === null) {
    if (property.required) throw new Unplaceable(`${property.name} is required and missing`);
    return null;
  }
  const wrong = (): never => {
    throw new Unplaceable(`${property.name} is not a ${property.logicalType ?? "string"}: ${JSON.stringify(value)}`);
  };
  switch (property.logicalType) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return wrong();
      const children = property.properties ?? [];
      if (children.length === 0) return JSON.stringify(value);
      return Object.fromEntries(children.map((child) => [child.name, valueOf(child, (value as Record<string, unknown>)[child.name])]));
    }
    case "array": {
      if (!Array.isArray(value)) return wrong();
      const item = { logicalType: "string", ...property.items, name: `${property.name}[]`, required: false };
      return value.map((element) => valueOf(item, element));
    }
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : wrong();
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : wrong();
    case "boolean":
      return typeof value === "boolean" ? value : wrong();
    case "timestamp": {
      const time = typeof value === "string" ? new Date(value) : undefined;
      return time && !Number.isNaN(time.getTime()) ? time : wrong();
    }
    case "date": {
      const day = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
      return Number.isNaN(day) ? wrong() : day / DAY;
    }
    default:
      return typeof value === "string" ? value : wrong();
  }
}

type Event = { id?: unknown; time?: unknown; [key: string]: unknown };

/** The day an event happened (UTC), from its CloudEvent `time`. */
export function dayOf(event: Event): string | undefined {
  const time = typeof event.time === "string" ? new Date(event.time) : undefined;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString().slice(0, 10) : undefined;
}

export type Compacted = { day: string; events: number; parquet: Uint8Array };
export type Rejected = { id: string; reason: string };

/**
 * One event type's raw lines - from any number of files, in any order, with
 * repeats - as a Parquet file for each day the events happened on. An event is
 * delivered at least once, so one with an id already seen is the same event.
 */
export function compact(object: SchemaObject, lines: Iterable<string>, days?: Set<string>): { files: Compacted[]; rejected: Rejected[] } {
  const byId = new Map<string, Event>();
  const rejected: Rejected[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      rejected.push({ id: "?", reason: "a line that is not JSON" });
      continue;
    }
    const id = typeof event.id === "string" ? event.id : undefined;
    if (!id) rejected.push({ id: "?", reason: "an event with no id" });
    else if (!byId.has(id)) byId.set(id, event);
  }
  const byDay = new Map<string, Record<string, unknown>[]>();
  for (const [id, event] of byId) {
    const day = dayOf(event);
    if (!day) {
      rejected.push({ id, reason: "an event with no time" });
      continue;
    }
    if (days && !days.has(day)) continue;
    try {
      const row = Object.fromEntries(object.properties.map((property) => [property.name, valueOf(property, event[property.name])]));
      byDay.set(day, [...(byDay.get(day) ?? []), row]);
    } catch (error) {
      if (!(error instanceof Unplaceable)) throw error;
      rejected.push({ id, reason: error.message });
    }
  }
  const schema = parquetSchema(object.properties);
  const files = [...byDay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, rows]) => {
      // In time order, then by id: the same events always make the same file.
      rows.sort((a, b) => Number(a.time) - Number(b.time) || String(a.id).localeCompare(String(b.id)));
      const columnData = object.properties.map((property) => ({ name: property.name, data: rows.map((row) => row[property.name]) }));
      return { day, events: rows.length, parquet: new Uint8Array(parquetWriteBuffer({ columnData, schema: schema as never })) };
    });
  return { files, rejected };
}

/** The days a run rewrites: the last `lookback` whole days before `today`, and today itself when asked. */
export function window(today: Date, lookback: number, includeToday: boolean): string[] {
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Array.from({ length: lookback }, (_, i) => new Date(start - (lookback - i) * DAY).toISOString().slice(0, 10));
  return includeToday ? [...days, new Date(start).toISOString().slice(0, 10)] : days;
}
