// Gate: a change to the contract is deliberate, visible and versioned.
// Compares specs/openapi.yaml with the last published contract and holds
// info.version to semantic versioning:
//   - a breaking change needs a new MAJOR version (while the major is 0, a new minor)
//   - any other change to the API needs at least a new MINOR version
//   - any edit at all needs a new version
// The baseline is the contract on the default branch (for a branch), or in
// the previous commit (on the default branch). Override with SPEC_BASELINE=<git ref>.
import SwaggerParser from "@apidevtools/swagger-parser";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CONTRACT = "specs/openapi.yaml";
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};
const skip = (why: string): never => {
  console.log(`spec:compat skipped - ${why}`);
  process.exit(0);
};

function baseline(): string {
  if (process.env.SPEC_BASELINE) return process.env.SPEC_BASELINE;
  const head = git("rev-parse", "HEAD");
  const trunk = ["origin/HEAD", "origin/main", "origin/master"].find((ref) => git("rev-parse", "--verify", "--quiet", ref));
  const fork = trunk && git("merge-base", "HEAD", trunk);
  // On a branch: where it left the default branch. On the default branch: the commit before.
  if (fork && fork !== head) return fork;
  return git("rev-parse", "--verify", "--quiet", "HEAD~1") ?? skip("there is no earlier commit to compare with");
}

const ref = baseline();
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
const edited = before.trim() !== readFileSync(CONTRACT, "utf8").trim();

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
} else if (edited && !bumped.any) {
  problems.push(`the contract was edited but info.version is still ${current.info?.version}; every published edit needs a new version`);
}

const section = (title: string, list: Change[]) => (list.length > 0 ? [`  ${title}`, ...list.map(describe)] : []);
const report = [
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
      ? `spec:compat ok - the contract is unchanged since ${ref.slice(0, 12)}`
      : `spec:compat ok - ${from} -> ${current.info?.version}: ${breaking.length} breaking, ${risky.length} possibly breaking, ${changes.length - breaking.length - risky.length} other changes`,
    ...report,
  ].join("\n"),
);
