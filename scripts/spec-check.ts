// Gate: the spec is complete enough to drive an implementation.
//   - specs/openapi.yaml is a valid OpenAPI document with at least one operation
//   - every operation has a unique operationId
//   - every operation is covered by a scenario tagged @operation:<operationId>
//   - every @operation tag names an operation that exists
//   - every operation the contract secures uses HTTP bearer auth and documents 401
import SwaggerParser from "@apidevtools/swagger-parser";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const problems: string[] = [];

type Security = Record<string, string[]>[];
type Api = {
  paths?: Record<string, Record<string, { operationId?: string; security?: Security; responses?: Record<string, unknown> }>>;
  security?: Security;
  components?: { securitySchemes?: Record<string, { type?: string; scheme?: string }> };
};
let api: Api = {};
let paths: NonNullable<Api["paths"]> = {};
try {
  api = (await SwaggerParser.validate("specs/openapi.yaml")) as Api;
  paths = api.paths ?? {};
} catch (error) {
  problems.push(`specs/openapi.yaml is not a valid OpenAPI document: ${(error as Error).message}`);
}

const operationIds: string[] = [];
for (const [path, item] of Object.entries(paths)) {
  for (const method of METHODS.filter((m) => item[m])) {
    const id = item[method]!.operationId;
    if (!id) problems.push(`${method.toUpperCase()} ${path} has no operationId`);
    else if (operationIds.includes(id)) problems.push(`operationId ${id} is used more than once`);
    else operationIds.push(id);

    // Authentication is the skeleton's: an API Gateway JWT authorizer on AWS,
    // which answers 401 itself. That is the only scheme it knows how to enforce.
    const security = item[method]!.security ?? api.security ?? [];
    const secured = security.length > 0 && security.every((requirement) => Object.keys(requirement).length > 0);
    if (!secured) continue;
    const name = id ?? `${method.toUpperCase()} ${path}`;
    for (const scheme of new Set(security.flatMap((requirement) => Object.keys(requirement)))) {
      const definition = api.components?.securitySchemes?.[scheme];
      if (definition?.type !== "http" || definition.scheme?.toLowerCase() !== "bearer") {
        problems.push(`${name} is secured by "${scheme}", which is not an HTTP bearer scheme - the only kind the template enforces`);
      }
    }
    if (!item[method]!.responses?.["401"]) problems.push(`${name} is secured but does not document a 401 response`);
  }
}
if (problems.length === 0 && operationIds.length === 0) {
  problems.push("specs/openapi.yaml declares no operations - add your API contract");
}

const features = readdirSync("specs/features", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".feature"));
if (features.length === 0) problems.push("specs/features contains no .feature files - add your behaviour spec");

// An API may also have an AsyncAPI contract (specs/asyncapi.yaml). Its
// operations are tagged the same way; `task asyncapi:check` holds them to it.
let asyncIds: string[] = [];
if (existsSync("specs/asyncapi.yaml")) {
  try {
    asyncIds = Object.keys((parseYaml(readFileSync("specs/asyncapi.yaml", "utf8")) as { operations?: Record<string, unknown> })?.operations ?? {});
  } catch {
    // Not readable as YAML: asyncapi:check says so.
  }
}
for (const id of asyncIds.filter((id) => operationIds.includes(id))) problems.push(`operation ${id} is in both specs/openapi.yaml and specs/asyncapi.yaml; an operation's name is unique across the two`);

const tagged = new Set<string>();
for (const feature of features) {
  for (const [, id] of readFileSync(join("specs/features", feature), "utf8").matchAll(/@operation:([\w.-]+)/g)) {
    tagged.add(id!);
    if (!operationIds.includes(id!) && !asyncIds.includes(id!)) problems.push(`${feature} is tagged @operation:${id}, which is not an operationId in the contract`);
  }
}
for (const id of operationIds.filter((id) => !tagged.has(id))) {
  problems.push(`operation ${id} has no scenario tagged @operation:${id}`);
}

if (problems.length > 0) {
  console.error("spec:check failed\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`spec:check ok - ${operationIds.length} operations, ${features.length} feature files, every operation has a scenario`);
