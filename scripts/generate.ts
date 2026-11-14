// Turn the contract into everything that can be derived from it without thought:
//   src/generated/openapi.json - the dereferenced contract, bundled into the
//     Lambda for request validation and read by the local harness and steps
//   src/generated/api.d.ts     - compile-time types for every operation
//   src/generated/routes.ts    - the route table: every operationId wired to
//     the function of that name in src/operations/<operationId>.ts
import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdirSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";

const source = "specs/openapi.yaml";
mkdirSync("src/generated", { recursive: true });

const dereferenced = await SwaggerParser.dereference(source);
writeFileSync("src/generated/openapi.json", JSON.stringify(dereferenced, null, 2) + "\n");

const ast = await openapiTS(new URL(`../${source}`, import.meta.url));
writeFileSync("src/generated/api.d.ts", astToString(ast));

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const operationIds = Object.values((dereferenced as { paths?: Record<string, Record<string, { operationId?: string }>> }).paths ?? {})
  .flatMap((item) => METHODS.filter((method) => item[method]?.operationId).map((method) => item[method]!.operationId!))
  .sort();
writeFileSync(
  "src/generated/routes.ts",
  [
    "// Generated from specs/openapi.yaml by `task generate` - do not edit.",
    "// A missing import means an operation has no file yet: run `task scaffold`.",
    'import type { Routes } from "../lib/router.ts";',
    ...operationIds.map((id) => `import { ${id} } from "../operations/${id}.ts";`),
    "",
    `export const routes: Routes = {${operationIds.length > 0 ? ` ${operationIds.join(", ")} ` : ""}};`,
    "",
  ].join("\n"),
);

console.log(`generated src/generated/{openapi.json,api.d.ts,routes.ts} from ${source}`);
