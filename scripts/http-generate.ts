// Write http/contract.http: one ready-to-send request for every operation in
// the contract, for exploring the API by hand (task http). It is committed, so
// it can be read and run without generating anything, and `task http:check`
// fails when it no longer matches the contract. Keep requests of your own in
// other files in http/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

type Schema = {
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  minLength?: number;
};
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema; example?: unknown };
type Operation = {
  operationId?: string;
  summary?: string;
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema; example?: unknown }> };
};
type Contract = { paths?: Record<string, Record<string, unknown>>; security?: Record<string, string[]>[] };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const contract = JSON.parse(readFileSync("src/generated/openapi.json", "utf8")) as Contract;

/** A plausible value for a schema: its example, else the simplest thing that satisfies it. */
function sample(schema: Schema = {}, name = "value"): unknown {
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

const variables = new Map<string, unknown>();
const requests: string[] = [];

for (const [path, item] of Object.entries(contract.paths ?? {})) {
  for (const method of METHODS.filter((m) => item[m])) {
    const operation = item[method] as Operation;
    const parameters = [...((item.parameters as Parameter[]) ?? []), ...(operation.parameters ?? [])];
    const security = operation.security ?? contract.security ?? [];
    const secured = security.length > 0 && security.every((requirement) => Object.keys(requirement).length > 0);

    // Path parameters become file variables, set once at the top.
    for (const p of parameters.filter((p) => p.in === "path")) {
      if (!variables.has(p.name)) variables.set(p.name, p.example ?? sample(p.schema, p.name));
    }
    const query = parameters.filter((p) => p.in === "query");
    const sent = query.filter((p) => p.required);
    const url = `{{base_url}}${path.replace(/\{(\w+)\}/g, "{{$1}}")}${
      sent.length > 0 ? "?" + sent.map((p) => `${p.name}=${encodeURIComponent(String(p.example ?? sample(p.schema, p.name)))}`).join("&") : ""
    }`;
    const media = operation.requestBody?.content?.["application/json"];
    const body = media && (media.example ?? sample(media.schema));

    requests.push(
      [
        `### ${operation.summary ?? operation.operationId ?? `${method} ${path}`}`,
        ...(operation.operationId ? [`# @name ${operation.operationId}`] : []),
        ...query.filter((p) => !p.required).map((p) => `# optional query: ${p.name}=${String(p.example ?? sample(p.schema, p.name))}`),
        `${method.toUpperCase()} ${url}`,
        ...(secured ? ["Authorization: Bearer {{token}}"] : []),
        ...(body === undefined ? [] : ["Content-Type: application/json", "", JSON.stringify(body, null, 2)]),
      ].join("\n"),
    );
  }
}

const header = [
  "# Generated from specs/openapi.yaml by `task http:generate` - do not edit; commit it when the contract changes.",
  "# Send with `task http`, or open in an editor with an HTTP client (httpYac, JetBrains).",
  "# Environments (mock, local, aws) are in http/http-client.env.json.",
  "",
  ...[...variables].map(([name, value]) => `@${name} = ${String(value)}`),
];

const target = "http/contract.http";
const generated = [header.join("\n"), ...requests].join("\n\n") + "\n";

// `check` compares with the file as it is, so it passes as soon as the file
// has been regenerated - committed or not.
if (process.argv[2] === "check") {
  if (!existsSync(target) || readFileSync(target, "utf8") !== generated) {
    console.error("http:check failed\n  - http/contract.http does not match the contract; run `task http:generate` and commit it");
    process.exit(1);
  }
  console.log(`http:check ok - http/contract.http matches the contract, ${requests.length} requests`);
} else {
  mkdirSync("http", { recursive: true });
  writeFileSync(target, generated);
  console.log(`generated http/contract.http - ${requests.length} requests`);
}
