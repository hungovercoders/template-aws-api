// The skeleton is the same for every API and is not edited per API. This
// records what it is (lock) and fails when it has changed (check).
//   node scripts/skeleton.ts check   - gate: every skeleton file matches skeleton.lock
//   node scripts/skeleton.ts lock    - accept the skeleton as it is now
// Changing the skeleton stays possible, but never silent: it takes a
// deliberate `task skeleton:lock`, and the changed lock is there to review.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { declarations, lock, owns, removed, split } from "./components-lib.ts";

const LOCK = "skeleton.lock";

// What an API built on the template does not own. Not listed, because they
// are yours: specs/, http/, steps/ (but world.ts), src/operations, src/domain,
// src/store, your tests, .spectral.yaml, README.md, AGENTS.md, CLAUDE.md, package.json,
// skills.json and the skills it lists.
const SKELETON = [
  "Taskfile.yml",
  "components.json",
  "cucumber.mjs",
  "tsconfig.json",
  "vitest.config.ts",
  ".github/workflows/ci.yml",
  ".githooks/",
  "rules/",
  "scripts/",
  "tools/",
  "local/",
  "src/handler.ts",
  "src/lib/",
  "steps/world.ts",
  "test/routes.test.ts",
  "test/log.test.ts",
  "test/components.test.ts",
  "test/asyncapi.test.ts",
  "test/cloudevents.test.ts",
  "infra/",
  // The template's own skills. Skills copied from elsewhere are held by
  // `task skills:check` instead, so adding or updating one is not a skeleton change.
  ".claude/skills/implement-api/",
  ".claude/skills/write-spec/",
];
// A tool package's dependencies move with Renovate, like the root package.json, which is not skeleton either.
const NOT_SOURCE = /(^|\/)\.terraform(\/|\.lock\.hcl$)|\.tfstate|^tools\/[^/]+\/package(-lock)?\.json$/;

// Routine version bumps are not skeleton changes: pins are read as "some version".
function normalised(path: string, text: string): string {
  const unix = text.replace(/\r\n/g, "\n");
  if (path === "Taskfile.yml") return unix.replace(/^(\s*\w+_VERSION:).*$/gm, "$1 *");
  if (path.startsWith(".github/workflows/")) return unix.replace(/^(\s*-?\s*uses:\s*[^@\s]+)@\S+/gm, "$1@*");
  return unix;
}

// One entry per skeleton file. A file that carries sections of optional
// components (scripts/components-lib.ts) is recorded in parts: the file without
// them, and each component's sections as "path#component". So removing a
// component, or restoring it from the template, never needs a new lock.
const markers: string[] = [];
const placeholders: [path: string, component: string][] = [];
function current(): Map<string, string> {
  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SKELETON], { encoding: "utf8" });
  const files = listed.stdout.split("\n").filter((path) => path && !NOT_SOURCE.test(path) && existsSync(path));
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const entries = new Map<string, string>();
  for (const path of files.sort()) {
    const text = normalised(path, readFileSync(path, "utf8"));
    // The scripts that implement the markers, and their test, name them without being marked.
    const parts = path.startsWith("scripts/components") || path === "test/components.test.ts" ? { core: text, sections: new Map<string, string[]>(), placeholders: new Map(), problems: [] } : split(text);
    markers.push(...parts.problems.map((problem) => `${path}: ${problem}`));
    for (const name of parts.placeholders.keys()) placeholders.push([path, name]);
    entries.set(path, hash(parts.core));
    for (const [name, sections] of parts.sections) entries.set(`${path}#${name}`, hash(sections.join("\n")));
  }
  return entries;
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
const locked = lock(LOCK);

// What a removed component took with it is expected to be missing, and
// nothing of it may remain.
const gone = removed();
const components = declarations().components;
const taken = (entry: string) => {
  const [path, section] = entry.split("#") as [string, string | undefined];
  return section ? gone.has(section) : [...gone].some((name) => components[name] && owns(components[name], path));
};

const problems = [
  ...markers,
  // A placeholder stands for a section this repository removed, and nothing else.
  ...placeholders.filter(([path, name]) => !gone.has(name) || !locked.has(`${path}#${name}`)).map(([path, name]) => `${path}: component:${name}:removed is not a section this repository removed`),
  ...[...locked].filter(([entry, hash]) => now.has(entry) && !taken(entry) && now.get(entry) !== hash).map(([entry]) => `changed: ${entry}`),
  ...[...locked.keys()].filter((entry) => !now.has(entry) && !taken(entry)).map((entry) => `removed: ${entry}`),
  ...[...now.keys()].filter((entry) => !locked.has(entry)).map((entry) => `added:   ${entry}`),
  ...[...now.keys()].filter(taken).map((entry) => `still here: ${entry} belongs to a component recorded as removed in .components - run \`task component:remove\` again, or \`task component:add\``),
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
