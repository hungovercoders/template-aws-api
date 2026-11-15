// Turn a repository created from the template into an API's repository.
// Run once, after the first spec is written (`task adopt`). It removes what
// is only about the template itself and leaves everything an API needs:
//   - deletes the template's self-test workflow and its branch ruleset
//   - removes the sections marked template-only from the Markdown files
//   - names AGENTS.md after the API
//   - writes the README from the contract (task readme:generate)
// Safe to re-run: when there is nothing left to remove it changes nothing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const contract = JSON.parse(readFileSync("src/generated/openapi.json", "utf8")) as { info?: { title?: string }; paths?: Record<string, unknown> };
if (Object.keys(contract.paths ?? {}).length === 0) {
  console.error("adopt: the contract declares no operations yet. Write the spec first (/write-spec), then run `task adopt`.");
  process.exit(1);
}

const done: string[] = [];

// .github/images holds the template README's own pictures, which go with that README.
for (const path of [".github/workflows/template.yml", ".github/rulesets", ".github/images"]) {
  if (!existsSync(path)) continue;
  rmSync(path, { recursive: true });
  done.push(`deleted ${path}`);
}

const TEMPLATE_ONLY = /\n?<!-- template-only:start[^>]*-->[\s\S]*?<!-- template-only:end -->\n?/g;
for (const path of ["CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", ".github/PULL_REQUEST_TEMPLATE.md"]) {
  if (!existsSync(path)) continue;
  const before = readFileSync(path, "utf8");
  let after = before.replace(TEMPLATE_ONLY, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (path === "AGENTS.md" && contract.info?.title) after = after.replace(/^# .*$/m, `# ${contract.info.title}`);
  if (after === before) continue;
  writeFileSync(path, after);
  done.push(`removed template-only sections from ${path}`);
}

const readme = spawnSync(process.execPath, ["scripts/readme.ts", "generate"], { stdio: "inherit" });
if (readme.status !== 0) process.exit(readme.status ?? 1);

// From here on the fast gates should be green, so run them before every push.
if (spawnSync("git", ["config", "core.hooksPath", ".githooks"]).status === 0) done.push("installed the pre-push hook (task check before every push; git push --no-verify skips one)");

console.log(done.length > 0 ? ["adopt: this repository now describes its API", ...done.map((line) => `  - ${line}`)].join("\n") : "adopt: nothing left to remove");
console.log("  Review the changes and commit them. LICENSE is yours to check: change the copyright line if the code is not MIT or not yours to license that way.");
