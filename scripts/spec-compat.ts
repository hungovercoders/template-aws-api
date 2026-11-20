// Gate: a change to the spec is deliberate, visible and versioned.
// Each major's contract (specs/openapi.v<N>.yaml) is compared with what was
// last published of that same major, and its info.version is held to
// semantic versioning:
//   - a breaking contract change needs a new MAJOR version (while the major is
//     0, a new minor). A new major is a new file beside the old one: the old
//     major's consumers keep it until it is retired.
//   - any other change to the contract, and any existing scenario tagged with
//     one of its operations that was changed or removed, needs at least a new MINOR version
//   - any edit at all needs a new version
// A contract diff cannot see a rule that changed while its shape stayed the
// same, so changed and removed scenarios are listed too: they are behaviour
// consumers may rely on, and whether that makes the change breaking - a new
// major - is a decision for a person, which this gate makes visible.
// A major that was published is removed only once it was published deprecated.
// The baseline is the contract on the default branch (for a branch), or in
// the previous commit (on the default branch). Override with SPEC_BASELINE=<git ref>.
import SwaggerParser from "@apidevtools/swagger-parser";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { atBaseline, type Contract, contracts, retired } from "./contracts.ts";
import { baseline } from "./spec-baseline.ts";

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const ref = baseline();
if (!ref) {
  console.log("spec:compat skipped - there is no earlier commit to compare with");
  process.exit(0);
}
const short = ref.slice(0, 12);

// --- Behaviour: scenarios that existed before and are now different or gone ---
const FEATURES = "specs/features";
type Scenario = { steps: string; tags: string[] };
/** Each scenario's steps and the operations it is tagged with, by "file: name". Names, comments and layout are not behaviour. */
function scenarios(file: string, text: string): Map<string, Scenario> {
  const found = new Map<string, Scenario>();
  let name: string | undefined;
  let featureTags: string[] = [];
  let pending: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (line.startsWith("@")) {
      pending.push(...[...line.matchAll(/@operation:([\w.-]+)/g)].map(([, id]) => id!));
      continue;
    }
    if (/^Feature:/.test(line)) {
      featureTags = pending;
      pending = [];
      continue;
    }
    const heading = /^(Background|Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/.exec(line);
    if (heading) {
      name = `${file}: ${heading[1] === "Background" ? "Background" : heading[2]}`;
      found.set(name, { steps: "", tags: [...featureTags, ...pending] });
      pending = [];
    } else if (name && line && !line.startsWith("#") && !/^(Rule):/.test(line)) {
      found.get(name)!.steps += line + "\n";
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
const live = contracts("openapi");
/** The HTTP majors a scenario is about: those of the operations it is tagged with, else (events only, say) the newest. */
function majorsOf(scenario: Scenario): number[] {
  const tagged = scenario.tags.map((id) => /_v(0|[1-9][0-9]*)$/.exec(id)?.[1]).filter((major): major is string => major !== undefined).map(Number);
  const known = tagged.filter((major) => live.some((contract) => contract.major === major));
  return known.length > 0 ? [...new Set(known)] : live.length > 0 ? [live.at(-1)!.major] : [];
}
const behaviourOf = (major: number) => [
  ...[...scenariosBefore].filter(([name, was]) => scenariosNow.has(name) && scenariosNow.get(name)!.steps !== was.steps && majorsOf(was).includes(major)).map(([name]) => `changed: ${name}`),
  ...[...scenariosBefore].filter(([name, was]) => !scenariosNow.has(name) && majorsOf(was).includes(major)).map(([name]) => `removed: ${name}`),
];
const addedTo = (major: number) => [...scenariosNow].filter(([name, scenario]) => !scenariosBefore.has(name) && majorsOf(scenario).includes(major)).length;

type Api = { info?: { version?: string }; paths?: Record<string, unknown> };
type Change = { id: string; text: string; level: number; operation?: string; path?: string };
const describe = (change: Change) => `    ${[change.operation, change.path].filter(Boolean).join(" ")}: ${change.text}  [${change.id}]`;
const parse = (version: string | undefined) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "")?.slice(1).map(Number);

const problems: string[] = [];
const lines: string[] = [];
mkdirSync(".local", { recursive: true });

async function compare(contract: Contract): Promise<void> {
  const before = atBaseline(contract, ref!);
  const current = (await SwaggerParser.parse(contract.path)) as Api;
  const label = `v${contract.major} (${contract.path})`;
  if (before === undefined) return void lines.push(`  ${label}: new since ${short} - a new major has nothing published to break`);
  const beforePath = `.local/baseline-openapi.v${contract.major}.yaml`;
  writeFileSync(beforePath, before + "\n");
  const old = (await SwaggerParser.parse(beforePath)) as Api;
  if (Object.keys(old.paths ?? {}).length === 0) return void lines.push(`  ${label}: the contract at ${short} declares no operations, so there is nothing to break`);

  const diff = spawnSync("oasdiff", ["changelog", beforePath, contract.path, "--format", "json"], { encoding: "utf8" });
  if (diff.error || diff.status !== 0) {
    console.error(`spec:compat could not run oasdiff (${diff.error?.message ?? diff.stderr.trim()}). It is installed by \`mise install\`.`);
    process.exit(1);
  }
  // oasdiff has version rules of its own; the policy here is the one this gate states.
  const changes = (JSON.parse(diff.stdout.trim() || "[]") as Change[]).filter((change) => !/^api-.*version/.test(change.id));
  const breaking = changes.filter((change) => change.level >= 3);
  const risky = changes.filter((change) => change.level === 2);
  const behaviour = behaviourOf(contract.major);
  const added = addedTo(contract.major);
  const edited = before.trim() !== readFileSync(contract.path, "utf8").trim() || behaviour.length > 0 || added > 0;

  const now = parse(current.info?.version);
  if (!now) return void problems.push(`${contract.path}: info.version "${current.info?.version}" is not a semantic version (MAJOR.MINOR.PATCH)`);
  const [major, minor, patch] = now as [number, number, number];
  const [oldMajor, oldMinor, oldPatch] = (parse(old.info?.version) ?? [0, 0, 0]) as [number, number, number];
  const bumped = {
    major: major > oldMajor,
    minor: major > oldMajor || (major === oldMajor && minor > oldMinor),
    any: major > oldMajor || (major === oldMajor && (minor > oldMinor || (minor === oldMinor && patch > oldPatch))),
  };
  const from = `${old.info?.version} (at ${short})`;
  if (breaking.length > 0 && !(oldMajor === 0 && bumped.minor)) {
    problems.push(
      oldMajor === 0
        ? `${contract.path} has breaking changes but info.version went from ${from} to ${current.info?.version}; while the API is 0.x a breaking change needs a new minor version`
        : `${contract.path} has breaking changes: v${contract.major}'s consumers would fail. Make the change in specs/openapi.v${contract.major + 1}.yaml, a new major served beside this one, and leave v${contract.major} as it is`,
    );
  } else if (changes.length > 0 && !bumped.minor) {
    problems.push(`${contract.path}: the API changed but info.version went from ${from} to ${current.info?.version}; a change to the API needs at least a new minor version`);
  } else if (behaviour.length > 0 && !bumped.minor) {
    problems.push(
      `${contract.path}: existing scenarios were changed or removed but info.version went from ${from} to ${current.info?.version}; changed behaviour needs at least a new minor version, and a new major if consumers can observe it`,
    );
  } else if (edited && !bumped.any) {
    problems.push(`${contract.path}: the spec was edited but info.version is still ${current.info?.version}; every published edit needs a new version`);
  }

  const section = (title: string, list: Change[]) => (list.length > 0 ? [`    ${title}`, ...list.map((change) => `  ${describe(change)}`)] : []);
  lines.push(
    edited
      ? `  ${label}: ${from} -> ${current.info?.version}: ${breaking.length} breaking, ${risky.length} possibly breaking, ${changes.length - breaking.length - risky.length} other contract changes; ${behaviour.length} existing scenarios changed or removed, ${added} added`
      : `  ${label}: unchanged since ${short}`,
    ...(behaviour.length > 0
      ? [
          "    Existing behaviour changed - the contract's shape may be the same, but what consumers get is not.",
          "    If a consumer can observe this, it is breaking and needs a new major version. That is a person's decision:",
          ...behaviour.map((line) => `      ${line}`),
        ]
      : []),
    ...section("Breaking changes - existing consumers will fail:", breaking),
    ...section("Possibly breaking - check with consumers:", risky),
    ...section("Other changes:", changes.filter((change) => change.level < 2)),
  );
}

for (const contract of live) await compare(contract);
const { gone, problems: unannounced } = retired("openapi", ref);
problems.push(...unannounced);
lines.push(...gone.filter((contract) => !unannounced.some((problem) => problem.startsWith(contract.path))).map((contract) => `  v${contract.major} (${contract.path}): retired - it was published deprecated`));

if (problems.length > 0) {
  console.error(["spec:compat failed", ...problems.map((p) => `  - ${p}`), ...lines].join("\n"));
  process.exit(1);
}
console.log([`spec:compat ok - ${live.length} major${live.length === 1 ? "" : "s"} compared with ${short}`, ...lines].join("\n"));
