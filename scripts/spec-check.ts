// Gate: the spec is complete enough to drive an implementation.
//   - every specs/openapi.v<N>.yaml is a valid OpenAPI document, its version's
//     major is N, its paths start /v<N> and its operationIds end _v<N>
//   - together they have at least one operation, and every operationId is unique
//   - every operation is covered by a scenario tagged @operation:<operationId>
//   - every @operation tag names an operation that exists
//   - every operation a contract secures uses HTTP bearer auth and documents 401
import SwaggerParser from "@apidevtools/swagger-parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { contracts, misnamed, openapiNameProblems, rateLimitProblems, versionProblems } from "./contracts.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const problems: string[] = [...misnamed("openapi"), ...misnamed("asyncapi")];

type Security = Record<string, string[]>[];
type Api = {
  info?: { version?: string };
  paths?: Record<string, Record<string, { operationId?: string; security?: Security; responses?: Record<string, unknown> }>>;
  security?: Security;
  components?: { securitySchemes?: Record<string, { type?: string; scheme?: string }> };
};

const files = contracts("openapi");
if (files.length === 0) problems.push("there is no specs/openapi.v<N>.yaml - add your API contract (specs/openapi.v0.yaml for a 0.x API)");
const operationIds: string[] = [];
for (const contract of files) {
  let api: Api;
  try {
    api = (await SwaggerParser.validate(contract.path)) as Api;
  } catch (error) {
    problems.push(`${contract.path} is not a valid OpenAPI document: ${(error as Error).message}`);
    continue;
  }
  problems.push(...versionProblems(contract, api), ...openapiNameProblems(contract, api), ...rateLimitProblems(contract.path, api as Parameters<typeof rateLimitProblems>[1]));
  for (const [path, item] of Object.entries(api.paths ?? {})) {
    for (const method of METHODS.filter((m) => item[m])) {
      const id = item[method]!.operationId;
      if (!id) problems.push(`${contract.path}: ${method.toUpperCase()} ${path} has no operationId`);
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
}
if (problems.length === 0 && operationIds.length === 0) {
  problems.push(`${files.map((contract) => contract.path).join(", ")} declare${files.length === 1 ? "s" : ""} no operations - add your API contract`);
}

const features = readdirSync("specs/features", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".feature"));
if (features.length === 0) problems.push("specs/features contains no .feature files - add your behaviour spec");

// An API may also have AsyncAPI contracts (specs/asyncapi.v<N>.yaml). Their
// operations are tagged the same way; `task asyncapi:check` holds them to it.
const asyncIds: string[] = [];
for (const contract of contracts("asyncapi")) {
  try {
    asyncIds.push(...Object.keys((parseYaml(readFileSync(contract.path, "utf8")) as { operations?: Record<string, unknown> })?.operations ?? {}));
  } catch {
    // Not readable as YAML: asyncapi:check says so.
  }
}
for (const id of new Set(asyncIds.filter((id) => operationIds.includes(id)))) problems.push(`operation ${id} is in both an OpenAPI and an AsyncAPI contract; an operation's name is unique across them`);

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
