// The skeleton is the same for every API and is not edited per API. This
// records what it is (lock) and fails when it has changed (check).
//   node scripts/skeleton.ts check   - gate: every skeleton file matches skeleton.lock
//   node scripts/skeleton.ts lock    - accept the skeleton as it is now
// Changing the skeleton stays possible, but never silent: it takes a
// deliberate `task skeleton:lock`, and the changed lock is there to review.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LOCK = "skeleton.lock";

// What an API built on the template does not own. Not listed, because they
// are yours: specs/, http/, steps/ (but world.ts), src/operations, src/domain,
// src/store, your tests, .spectral.yaml, README.md, AGENTS.md, CLAUDE.md, package.json.
const SKELETON = [
  "Taskfile.yml",
  "cucumber.mjs",
  "tsconfig.json",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
  "rules/",
  "scripts/",
  "local/",
  "src/handler.ts",
  "src/lib/",
  "steps/world.ts",
  "test/routes.test.ts",
  "test/log.test.ts",
  "infra/",
  ".claude/skills/",
];
const NOT_SOURCE = /(^|\/)\.terraform(\/|\.lock\.hcl$)|\.tfstate/;

// Routine version bumps are not skeleton changes: pins are read as "some version".
function normalised(path: string, text: string): string {
  const unix = text.replace(/\r\n/g, "\n");
  if (path === "Taskfile.yml") return unix.replace(/^(\s*\w+_VERSION:).*$/gm, "$1 *");
  if (path.startsWith(".github/workflows/")) return unix.replace(/^(\s*-?\s*uses:\s*[^@\s]+)@\S+/gm, "$1@*");
  return unix;
}

function current(): Map<string, string> {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SKELETON], { encoding: "utf8" });
  const files = listed.stdout.split("\n").filter((path) => path && !NOT_SOURCE.test(path) && existsSync(path));
  return new Map(files.sort().map((path) => [path, createHash("sha256").update(normalised(path, readFileSync(path, "utf8"))).digest("hex")]));
}

const now = current();

if (process.argv[2] === "lock") {
  writeFileSync(
    LOCK,
    [
      "# The skeleton as last accepted. Checked by `task skeleton:check`; rewritten by `task skeleton:lock`.",
      "# A change to this file means the skeleton was changed on purpose - review what, and why.",
      ...[...now].map(([path, hash]) => `${hash}  ${path}`),
      "",
    ].join("\n"),
  );
  console.log(`skeleton:lock - ${now.size} files recorded in ${LOCK}`);
  process.exit(0);
}

if (!existsSync(LOCK)) {
  console.error(`skeleton:check failed\n  - ${LOCK} is missing; restore it from the template`);
  process.exit(1);
}
const locked = new Map(
  readFileSync(LOCK, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("  ") as [string, string])
    .map(([hash, path]) => [path, hash]),
);

const problems = [
  ...[...locked].filter(([path, hash]) => now.has(path) && now.get(path) !== hash).map(([path]) => `changed: ${path}`),
  ...[...locked.keys()].filter((path) => !now.has(path)).map((path) => `removed: ${path}`),
  ...[...now.keys()].filter((path) => !locked.has(path)).map((path) => `added:   ${path}`),
];

if (problems.length > 0) {
  console.error(
    [
      "skeleton:check failed - the skeleton differs from skeleton.lock",
      ...problems.map((problem) => `  - ${problem}`),
      "  The skeleton is the same for every API: implementing a spec should not change it.",
      "  Undo the change. If the skeleton really must change, a person runs `task skeleton:lock` and commits the result.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`skeleton:check ok - ${now.size} skeleton files match ${LOCK}`);
