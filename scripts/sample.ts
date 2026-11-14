// A plausible value for a JSON Schema: its example, else the simplest thing
// that satisfies it. Shared by the generated HTTP requests (http/contract.http)
// and the generated example messages, so both are made the same way.
export type Schema = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  example?: unknown;
  default?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  minimum?: number;
  minLength?: number;
};

// allOf is how a schema extends another: its parts describe one value.
function merged(schema: Schema): Schema {
  if (!schema.allOf) return schema;
  const { allOf, ...own } = schema;
  // An example or a default on a part is of that part, not of the whole.
  const parts = allOf.map(merged).map(({ example: _example, default: _default, ...part }) => part);
  return [...parts, own].reduce<Schema>(
    (all, part) => ({
      ...all,
      ...part,
      ...(all.properties || part.properties ? { properties: { ...all.properties, ...part.properties } } : {}),
      // Absent stays absent: a schema that names no required property is sampled with all of them.
      ...(all.required || part.required ? { required: [...new Set([...(all.required ?? []), ...(part.required ?? [])])] } : {}),
    }),
    {},
  );
}

export function sample(given: Schema = {}, name = "value"): unknown {
  const schema = merged(given);
  if (schema.const !== undefined) return schema.const;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    const required = schema.required ?? Object.keys(schema.properties ?? {});
    return Object.fromEntries(required.map((key) => [key, sample(schema.properties?.[key], key)]));
  }
  if (type === "array") return [sample(schema.items, name)];
  if (type === "integer" || type === "number") return schema.minimum ?? 1;
  if (type === "boolean") return true;
  if (schema.format === "uuid") return "00000000-0000-4000-8000-000000000000";
  if (schema.format === "date-time") return "2026-01-01T00:00:00Z";
  if (schema.format === "date") return "2026-01-01";
  return name.replace(/_/g, " ").padEnd(schema.minLength ?? 0, "x");
}
