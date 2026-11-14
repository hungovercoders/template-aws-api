// Gate: the spec is complete enough to drive an implementation.
//   - specs/openapi.yaml is a valid OpenAPI document with at least one operation
//   - every operation has a unique operationId
//   - every operation is covered by a scenario tagged @operation:<operationId>
//   - every @operation tag names an operation that exists
import SwaggerParser from "@apidevtools/swagger-parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const problems: string[] = [];

let paths: Record<string, Record<string, { operationId?: string }>> = {};
try {
  const api = await SwaggerParser.validate("specs/openapi.yaml");
  paths = (api as { paths?: typeof paths }).paths ?? {};
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
  }
}
if (problems.length === 0 && operationIds.length === 0) {
  problems.push("specs/openapi.yaml declares no operations - add your API contract");
}

const features = readdirSync("specs/features", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".feature"));
if (features.length === 0) problems.push("specs/features contains no .feature files - add your behaviour spec");

const tagged = new Set<string>();
for (const feature of features) {
  for (const [, id] of readFileSync(join("specs/features", feature), "utf8").matchAll(/@operation:([\w.-]+)/g)) {
    tagged.add(id!);
    if (!operationIds.includes(id!)) problems.push(`${feature} is tagged @operation:${id}, which is not an operationId in the contract`);
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
