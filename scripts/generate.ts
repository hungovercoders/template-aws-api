// Turn the HTTP contracts - every live major, specs/openapi.v<N>.yaml - into
// everything that can be derived from them without thought:
//   src/generated/openapi.json  - every major's operations in one dereferenced
//     document, each marked with the version of the contract it is from
//     (x-api-version). Bundled into the Lambda for request validation, read by
//     the local harness and steps, served by the mock and fuzzed.
//   src/generated/api.v<N>.d.ts - compile-time types for one major's contract;
//     import a major's schemas from its own file
//   src/generated/api.d.ts      - every major's operations, by operationId
//   src/generated/routes.ts     - the route table: every operationId wired to
//     the function of that name in src/operations/<operationId>.ts
import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
import { contracts } from "./contracts.ts";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
type Security = Record<string, string[]>[];
type Operation = { operationId?: string; security?: Security; [key: string]: unknown };
type Document = {
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, Record<string, unknown>>;
  security?: Security;
  components?: { securitySchemes?: Record<string, unknown> };
};

const files = contracts("openapi");
mkdirSync("src/generated", { recursive: true });
for (const stale of readdirSync("src/generated").filter((name) => /^api\.v\d+\.d\.ts$/.test(name))) rmSync(`src/generated/${stale}`);

const merged: Required<Pick<Document, "paths">> & Document = { paths: {} };
const schemes: Record<string, unknown> = {};
for (const { path, major } of files) {
  const document = (await SwaggerParser.dereference(path)) as Document;
  const version = document.info?.version ?? "0.0.0";
  // The newest major describes the API as a whole.
  merged.info = { ...document.info, version };
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    const copy: Record<string, unknown> = { ...item };
    for (const method of METHODS.filter((m) => item[m])) {
      const operation = item[method] as Operation;
      // A document's own security applies to each operation that does not say otherwise: it stays true once merged.
      copy[method] = { ...operation, security: operation.security ?? document.security ?? [], "x-api-version": version };
    }
    merged.paths[route] = copy;
  }
  Object.assign(schemes, document.components?.securitySchemes ?? {});
  writeFileSync(`src/generated/api.v${major}.d.ts`, astToString(await openapiTS(new URL(`../${path}`, import.meta.url))));
}
const document = { openapi: "3.1.0", info: { title: "API", ...merged.info, version: merged.info?.version ?? "0.0.0" }, paths: merged.paths, components: { securitySchemes: schemes } };
writeFileSync("src/generated/openapi.json", JSON.stringify(document, null, 2) + "\n");

writeFileSync(
  "src/generated/api.d.ts",
  [
    "// Generated from specs/openapi.v<N>.yaml by `task generate` - do not edit.",
    "// Every major's operations, by operationId. A major's schemas are in its own file: api.v<N>.d.ts.",
    ...files.map(({ major }) => `import type { operations as v${major} } from "./api.v${major}.d.ts";`),
    `export type operations = ${files.length > 0 ? files.map(({ major }) => `v${major}`).join(" & ") : "Record<never, never>"};`,
    "",
  ].join("\n"),
);

const operationIds = Object.values(document.paths)
  .flatMap((item) => METHODS.filter((method) => (item[method] as Operation | undefined)?.operationId).map((method) => (item[method] as Operation).operationId!))
  .sort();
writeFileSync(
  "src/generated/routes.ts",
  [
    "// Generated from specs/openapi.v<N>.yaml by `task generate` - do not edit.",
    "// A missing import means an operation has no file yet: run `task scaffold`.",
    'import type { Routes } from "../lib/router.ts";',
    ...operationIds.map((id) => `import { ${id} } from "../operations/${id}.ts";`),
    "",
    `export const routes: Routes = {${operationIds.length > 0 ? ` ${operationIds.join(", ")} ` : ""}};`,
    "",
  ].join("\n"),
);

console.log(`generated src/generated/{openapi.json,api.d.ts,${files.map(({ major }) => `api.v${major}.d.ts,`).join("")}routes.ts} from ${files.map(({ path }) => path).join(", ") || "no contract"}`);
