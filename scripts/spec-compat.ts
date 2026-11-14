// Gate: a change to the spec is deliberate, visible and versioned.
// Compares the contract AND the feature files with the last published spec
// and holds info.version to semantic versioning:
//   - a breaking contract change needs a new MAJOR version (while the major is 0, a new minor)
//   - any other change to the contract, and any existing scenario that was
//     changed or removed, needs at least a new MINOR version
//   - any edit at all needs a new version
// A contract diff cannot see a rule that changed while its shape stayed the
// same, so changed and removed scenarios are listed too: they are behaviour
// consumers may rely on, and whether that makes the change breaking - a new
// major - is a decision for a person, which this gate makes visible.
// The baseline is the contract on the default branch (for a branch), or in
// the previous commit (on the default branch). Override with SPEC_BASELINE=<git ref>.
import SwaggerParser from "@apidevtools/swagger-parser";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { baseline } from "./spec-baseline.ts";

const CONTRACT = "specs/openapi.yaml";
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const skip = (why: string): never => {
  console.log(`spec:compat skipped - ${why}`);
  process.exit(0);
};

const ref = baseline() ?? skip("there is no earlier commit to compare with");
const before = git("show", `${ref}:${CONTRACT}`) ?? skip(`${ref} has no ${CONTRACT}`);
mkdirSync(".local", { recursive: true });
const beforePath = ".local/baseline-openapi.yaml";
writeFileSync(beforePath, before + "\n");

type Api = { info?: { version?: string }; paths?: Record<string, unknown> };
const [old, current] = (await Promise.all([SwaggerParser.parse(beforePath), SwaggerParser.parse(CONTRACT)])) as [Api, Api];
if (Object.keys(old.paths ?? {}).length === 0) skip(`the contract at ${ref.slice(0, 12)} declares no operations, so there is nothing to break`);

const diff = spawnSync("oasdiff", ["changelog", beforePath, CONTRACT, "--format", "json"], { encoding: "utf8" });
if (diff.error || diff.status !== 0) {
  console.error(`spec:compat could not run oasdiff (${diff.error?.message ?? diff.stderr.trim()}). It is installed by \`mise install\`.`);
  process.exit(1);
}
type Change = { id: string; text: string; level: number; operation?: string; path?: string };
// oasdiff has version rules of its own; the policy here is the one this gate states.
const changes = (JSON.parse(diff.stdout.trim() || "[]") as Change[]).filter((change) => !/^api-.*version/.test(change.id));
const describe = (change: Change) => `    ${[change.operation, change.path].filter(Boolean).join(" ")}: ${change.text}  [${change.id}]`;
const breaking = changes.filter((change) => change.level >= 3);
const risky = changes.filter((change) => change.level === 2);
// --- Behaviour: scenarios that existed before and are now different or gone ---
const FEATURES = "specs/features";
/** Each scenario's steps, by "file: name". Names, tags, comments and layout are not behaviour. */
function scenarios(file: string, text: string): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\s+/g, " ");
    const heading = /^(Background|Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(line);
    if (heading) {
      name = `${file}: ${heading[1] === "Background" ? "Background" : heading[2]}`;
      found.set(name, "");
    } else if (name && line && !line.startsWith("#") && !line.startsWith("@") && !/^(Feature|Rule):/.test(line)) {
      found.set(name, found.get(name) + line + "\n");
    }
  }
  return found;
}
const collect = (files: string[], read: (file: string) => string | undefined) =>
  new Map(files.filter((file) => file.endsWith(".feature")).flatMap((file) => [...scenarios(file.replace(`${FEATURES}/`, ""), read(file) ?? "")]));
const scenariosBefore = collect((git("ls-tree", "-r", "--name-only", ref, "--", FEATURES) ?? "").split("\n"), (file) => git("show", `${ref}:${file}`));
const scenariosNow = collect(
  existsSync(FEATURES) ? readdirSync(FEATURES, { recursive: true, encoding: "utf8" }).map((file) => `${FEATURES}/${file}`) : [],
  (file) => readFileSync(file, "utf8"),
);
const behaviour = [
  ...[...scenariosBefore].filter(([name, steps]) => scenariosNow.has(name) && scenariosNow.get(name) !== steps).map(([name]) => `changed: ${name}`),
  ...[...scenariosBefore.keys()].filter((name) => !scenariosNow.has(name)).map((name) => `removed: ${name}`),
];
const added = [...scenariosNow.keys()].filter((name) => !scenariosBefore.has(name)).length;

const edited = before.trim() !== readFileSync(CONTRACT, "utf8").trim() || behaviour.length > 0 || added > 0;

const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);
const [was, now] = [parse(old.info?.version), parse(current.info?.version)];
if (!now) {
  console.error(`spec:compat failed\n  - info.version "${current.info?.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  process.exit(1);
}
const [major, minor, patch] = now as [number, number, number];
const [oldMajor, oldMinor, oldPatch] = (was ?? [0, 0, 0]) as [number, number, number];
const bumped = {
  major: major > oldMajor,
  minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
  any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
};

const from = `${old.info?.version} (at ${ref.slice(0, 12)})`;
const problems: string[] = [];
if (breaking.length > 0 && !(bumped.major || (oldMajor === 0 && bumped.minor))) {
  problems.push(
    `the contract has breaking changes but info.version went from ${from} to ${current.info?.version}; a breaking change needs a new ${oldMajor === 0 ? "minor version (the API is still 0.x)" : "major version"}`,
  );
} else if (changes.length > 0 && !bumped.minor) {
  problems.push(`the API changed but info.version went from ${from} to ${current.info?.version}; a change to the API needs at least a new minor version`);
} else if (behaviour.length > 0 && !bumped.minor) {
  problems.push(
    `existing scenarios were changed or removed but info.version went from ${from} to ${current.info?.version}; changed behaviour needs at least a new minor version, and a new major if consumers can observe it`,
  );
} else if (edited && !bumped.any) {
  problems.push(`the spec was edited but info.version is still ${current.info?.version}; every published edit needs a new version`);
}

const section = (title: string, list: Change[]) => (list.length > 0 ? [`  ${title}`, ...list.map(describe)] : []);
const report = [
  ...(behaviour.length > 0 && !bumped.major
    ? [
        "  Existing behaviour changed - the contract's shape may be the same, but what consumers get is not.",
        "  If a consumer can observe this, it is breaking and needs a new major version. That is a person's decision:",
        ...behaviour.map((line) => `    ${line}`),
      ]
    : behaviour.length > 0
      ? ["  Existing behaviour changed:", ...behaviour.map((line) => `    ${line}`)]
      : []),
  ...section("Breaking changes - existing consumers will fail:", breaking),
  ...section("Possibly breaking - check with consumers:", risky),
  ...section("Other changes:", changes.filter((change) => change.level < 2)),
];

if (problems.length > 0) {
  console.error(["spec:compat failed", ...problems.map((p) => `  - ${p}`), ...report].join("\n"));
  process.exit(1);
}
console.log(
  [
    !edited
      ? `spec:compat ok - the spec is unchanged since ${ref.slice(0, 12)}`
      : `spec:compat ok - ${from} -> ${current.info?.version}: ${breaking.length} breaking, ${risky.length} possibly breaking, ${changes.length - breaking.length - risky.length} other contract changes; ${behaviour.length} existing scenarios changed or removed, ${added} added`,
    ...report,
  ].join("\n"),
);
