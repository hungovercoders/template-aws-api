// Write every file whose outline follows from the specs, so that only the
// thinking is left to do by hand:
//   src/operations/<operationId>.ts - a typed stub for each operation that has
//     no file yet, answering 501 until it is implemented
//   steps/scaffold.ts               - a typed pending step for each sentence in
//     the feature files that no step definition matches yet
// Safe to re-run: it never overwrites, it only adds what is missing.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

type OperationObject = { operationId?: string; summary?: string };
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const contract = JSON.parse(readFileSync("src/generated/openapi.json", "utf8")) as { paths?: Record<string, Record<string, OperationObject>> };

// --- Operations ---------------------------------------------------------------

mkdirSync("src/operations", { recursive: true });
const written: string[] = [];
for (const [path, item] of Object.entries(contract.paths ?? {})) {
  for (const method of METHODS.filter((m) => item[m]?.operationId)) {
    const { operationId: id, summary } = item[method]!;
    const target = `src/operations/${id}.ts`;
    if (existsSync(target)) continue;
    writeFileSync(
      target,
      `import { HttpProblem, type Result } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";

/**
 * ${summary ?? id} - ${method.toUpperCase()} ${path}
 * @scaffold Written by \`task scaffold\`. Implement it, then delete this line.
 */
export async function ${id}(context: Context<"${id}">): Promise<Result> {
  throw new HttpProblem(501, "Not Implemented", "${id} is not implemented yet.");
}
`,
    );
    written.push(target);
  }
}

// --- Steps --------------------------------------------------------------------
// cucumber itself says which sentences have no step definition and what each
// one's pattern and arguments are; this only gives its snippets types.

mkdirSync(".local", { recursive: true });
const snippets = ".local/snippets.txt";
rmSync(snippets, { force: true });
spawnSync("npx", ["cucumber-js", "--dry-run", "--format", `snippets:${snippets}`, "--format-options", '{"snippetInterface":"async-await"}'], {
  stdio: ["ignore", "ignore", "inherit"],
});

const TYPES: [RegExp, string][] = [
  [/^(int|float)\d*$/, "number"],
  [/^dataTable$/, "DataTable"],
];
const typed = (name: string) => `${name}: ${TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? "string"}`;

const target = "steps/scaffold.ts";
const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
const seen = new Set<string>();
const added: string[] = [];
for (const snippet of existsSync(snippets) ? readFileSync(snippets, "utf8").split(/\n\s*\n/) : []) {
  const match = /^(Given|When|Then)\((.+), async function \(([^)]*)\) \{$/m.exec(snippet);
  if (!match) continue;
  const [, keyword, pattern, args] = match;
  const key = `${keyword}(${pattern},`;
  if (seen.has(key) || existing.includes(key)) continue;
  seen.add(key);
  const parameters = ["this: ApiWorld", ...args!.split(",").map((arg) => arg.trim()).filter(Boolean).map(typed)].join(", ");
  added.push(`${keyword}(${pattern}, async function (${parameters}) {\n  return "pending";\n});\n`);
}

if (added.length > 0) {
  if (!existing) {
    writeFileSync(
      target,
      `// Written by \`task scaffold\`: one pending step for each sentence in specs/features
// that had no step definition. Implement each one - merge sentences that differ
// only in wording into a single pattern, and move them into files of your own
// naming if you prefer. A pending step fails the run, so none can be forgotten.
import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "./world.ts";
`,
    );
  }
  appendFileSync(target, "\n" + added.join("\n"));
}

console.log(`scaffold: ${written.length} operation stubs written, ${added.length} pending steps added to ${target}`);
for (const path of written) console.log(`  + ${path}`);
