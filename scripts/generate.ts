// Turn the contract into the two artefacts the code is built on:
//   src/generated/openapi.json - the dereferenced contract, bundled into the
//     Lambda for request validation and read by the local harness and steps
//   src/generated/api.d.ts     - compile-time types for every operation
import SwaggerParser from "@apidevtools/swagger-parser";
import { mkdirSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";

const source = "specs/openapi.yaml";
mkdirSync("src/generated", { recursive: true });

const dereferenced = await SwaggerParser.dereference(source);
writeFileSync("src/generated/openapi.json", JSON.stringify(dereferenced, null, 2) + "\n");

const ast = await openapiTS(new URL(`../${source}`, import.meta.url));
writeFileSync("src/generated/api.d.ts", astToString(ast));

console.log(`generated src/generated/{openapi.json,api.d.ts} from ${source}`);
