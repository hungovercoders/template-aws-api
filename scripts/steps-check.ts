// Gate: every step definition is used by a sentence in the feature files.
// When behaviour is changed or removed, its steps should go with it; left
// behind, they describe an API that no longer exists.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

mkdirSync(".local", { recursive: true });
const report = ".local/step-usage.json";
rmSync(report, { force: true });
spawnSync("npx", ["cucumber-js", "--dry-run", "--format", `usage-json:${report}`], { stdio: ["ignore", "ignore", "inherit"] });

if (!existsSync(report)) {
  console.error("steps:check could not read cucumber's usage report; run `npx cucumber-js --dry-run` to see why");
  process.exit(1);
}
type Definition = { pattern: string; uri: string; line: number; matches: unknown[] };
const definitions = JSON.parse(readFileSync(report, "utf8")) as Definition[];
const unused = definitions.filter((definition) => definition.matches.length === 0);

if (unused.length > 0) {
  console.error(
    [
      "steps:check failed - step definitions that no sentence in specs/features uses",
      ...unused.map((definition) => `  - ${definition.uri}:${definition.line}  ${definition.pattern}`),
      "  Delete them: the behaviour they described is no longer in the spec.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`steps:check ok - all ${definitions.length} step definitions are used`);
