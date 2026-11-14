// The contract at runtime. One module, three consumers:
//   - the Lambda router validates every request against it
//   - the local harness uses it to match routes the way API Gateway will
//   - the cucumber world validates every response against it
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import document from "../generated/openapi.json" with { type: "json" };

type Schema = Record<string, unknown>;
type Parameter = { name: string; in: string; required?: boolean; schema?: Schema };
type Media = { schema?: Schema };
type Response = { content?: Record<string, Media> };
type SecurityRequirement = Record<string, string[]>;
type OperationObject = {
  operationId?: string;
  security?: SecurityRequirement[];
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, Media> };
  responses?: Record<string, Response>;
};

export type Operation = {
  operationId: string;
  method: string;
  path: string;
  /** API Gateway HTTP API route key, e.g. "GET /things/{thingId}". */
  routeKey: string;
  parameters: Parameter[];
  requestBody?: { required: boolean; schema?: Schema };
  responses: Record<string, Response>;
  /** The contract's `security` requires a caller: API Gateway will only let authenticated requests through. */
  secured: boolean;
};

/** OpenAPI: an operation's own `security` replaces the document's; an empty requirement ({}) allows anonymous calls. */
function requiresCaller(requirements: SecurityRequirement[] | undefined): boolean {
  return requirements !== undefined && requirements.length > 0 && requirements.every((requirement) => Object.keys(requirement).length > 0);
}

export type Violation = { in: "path" | "query" | "body"; pointer: string; message: string };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

const contract = document as { paths?: Record<string, Record<string, unknown>>; security?: SecurityRequirement[] };

export const operations: Operation[] = Object.entries(contract.paths ?? {}).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => {
    const op = item[method] as OperationObject;
    const body = op.requestBody;
    return {
      operationId: op.operationId ?? `${method} ${path}`,
      method: method.toUpperCase(),
      path,
      routeKey: `${method.toUpperCase()} ${path}`,
      parameters: [...((item.parameters as Parameter[]) ?? []), ...(op.parameters ?? [])],
      requestBody: body && { required: body.required === true, schema: body.content?.["application/json"]?.schema },
      responses: op.responses ?? {},
      secured: requiresCaller(op.security ?? contract.security),
    };
  }),
);

const byRouteKey = new Map(operations.map((op) => [op.routeKey, op]));

export function operationForRouteKey(routeKey: string): Operation | undefined {
  return byRouteKey.get(routeKey);
}

/** Match a concrete request to an operation, as API Gateway matches routes. */
export function matchRoute(method: string, path: string): { operation: Operation; pathParameters: Record<string, string> } | undefined {
  const segments = path.split("/");
  // Literal segments win over {parameters}, as they do in API Gateway.
  const candidates = operations
    .filter((op) => op.method === method.toUpperCase())
    .sort((a, b) => (a.path.match(/\{/g)?.length ?? 0) - (b.path.match(/\{/g)?.length ?? 0));
  for (const operation of candidates) {
    const template = operation.path.split("/");
    if (template.length !== segments.length) continue;
    const pathParameters: Record<string, string> = {};
    const matches = template.every((part, i) => {
      const segment = segments[i]!;
      const name = /^\{(.+)\}$/.exec(part)?.[1];
      if (!name) return part === segment;
      if (segment === "") return false;
      pathParameters[name] = segment;
      return true;
    });
    if (matches) return { operation, pathParameters };
  }
  return undefined;
}

// Bodies are validated as sent; path and query values arrive as strings, so
// those are coerced to the types the contract declares, and a parameter the
// caller left out takes the default the contract gives it.
const strict = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const coercing = addFormats(new Ajv2020({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true }));
const compiled = new Map<string, ValidateFunction>();

function validator(key: string, ajv: Ajv2020, schema: Schema): ValidateFunction {
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

function violations(where: Violation["in"], errors: ErrorObject[] | null | undefined): Violation[] {
  return (errors ?? []).map((e) => ({ in: where, pointer: e.instancePath, message: e.message ?? "is invalid" }));
}

function parameterSchema(operation: Operation, where: "path" | "query"): Schema {
  const params = operation.parameters.filter((p) => p.in === where);
  return {
    type: "object",
    properties: Object.fromEntries(params.map((p) => [p.name, p.schema ?? {}])),
    required: params.filter((p) => p.required || where === "path").map((p) => p.name),
  };
}

export type RequestInput = {
  pathParameters: Record<string, string | undefined>;
  queryParameters: Record<string, string | undefined>;
  /** The parsed JSON body, or undefined when the request carried none. */
  body: unknown;
};

export type ValidRequest = { path: Record<string, unknown>; query: Record<string, unknown>; body: unknown };

export function validateRequest(operation: Operation, input: RequestInput): { ok: true; request: ValidRequest } | { ok: false; violations: Violation[] } {
  const found: Violation[] = [];
  const path = { ...input.pathParameters };
  const query = { ...input.queryParameters };

  for (const [where, value] of [["path", path], ["query", query]] as const) {
    const validate = validator(`${operation.operationId}:${where}`, coercing, parameterSchema(operation, where));
    if (!validate(value)) found.push(...violations(where, validate.errors));
  }

  const body = operation.requestBody;
  if (body) {
    if (input.body === undefined) {
      if (body.required) found.push({ in: "body", pointer: "", message: "a JSON request body is required" });
    } else if (body.schema) {
      const validate = validator(`${operation.operationId}:body`, strict, body.schema);
      if (!validate(input.body)) found.push(...violations("body", validate.errors));
    }
  }

  return found.length > 0 ? { ok: false, violations: found } : { ok: true, request: { path, query, body: input.body } };
}

/** What a response gets wrong against the contract; empty means it conforms. */
export function validateResponse(operation: Operation, status: number, contentType: string | undefined, body: unknown): string[] {
  const response = operation.responses[String(status)] ?? operation.responses.default;
  if (!response) {
    return [`status ${status} is not documented for ${operation.operationId} (documented: ${Object.keys(operation.responses).join(", ") || "none"})`];
  }
  const documented = Object.keys(response.content ?? {});
  if (documented.length === 0) {
    return body === undefined ? [] : [`${operation.operationId} ${status} documents no body but one was returned`];
  }
  const mediaType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const media = response.content![mediaType];
  if (!media) {
    return [`${operation.operationId} ${status} returned content-type "${mediaType}" (documented: ${documented.join(", ")})`];
  }
  if (!media.schema) return [];
  const validate = validator(`${operation.operationId}:${status}:${mediaType}`, strict, media.schema);
  if (validate(body)) return [];
  return (validate.errors ?? []).map((e) => `${operation.operationId} ${status} body${e.instancePath} ${e.message}`);
}
