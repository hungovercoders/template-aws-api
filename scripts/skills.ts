// Skills that come from somewhere else - AWS's, or one for a service this API
// integrates with - are copied into .claude/skills/ so every clone and every
// agent has them, and are never edited here. skills.json says where each came
// from and at which commit.
//   node scripts/skills.ts check             - gate: every listed skill is present, unedited and at its source's commit
//   node scripts/skills.ts fetch             - copy every listed skill from its source at the recorded commit
//   node scripts/skills.ts update            - move every source to the head of its branch, then fetch
//   node scripts/skills.ts add <name>        - add a skill the template offers (skills.json "offered")
//   node scripts/skills.ts add <name> --repository <git url> --path <dir in it> [--branch main]
//                                            - add a skill from any git repository
//   node scripts/skills.ts add <name> --manual
//                                            - record a skill that has no git source; you maintain .claude/skills/<name>/
// Renovate moves a source's commit; `task skills:fetch` then brings the files
// in line, and the gate fails until it has.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const LIST = "skills.json";
const DIR = join(".claude", "skills");
// A licence that lets a skill be copied asks that it travels with the copy.
const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md", "NOTICE.txt"];

type Source = { repository: string; branch: string; commit: string };
type Skill = { name: string; owner: "template" | "api"; for: string; source?: string; path?: string; fetched?: string; sha256?: string };
type Offered = { name: string; source: string; path: string; for: string; when: string };
type List = { sources: Record<string, Source>; skills: Skill[]; offered: Offered[]; integrations: unknown[] } & Record<string, unknown>;

const list = JSON.parse(readFileSync(LIST, "utf8")) as List;
const save = () => writeFileSync(LIST, JSON.stringify(list, null, 2) + "\n");
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

function filesIn(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? filesIn(path) : [path];
    })
    .sort();
}

// One hash for a skill's whole directory: every file's path and content.
function hashOf(dir: string): string {
  const hash = createHash("sha256");
  for (const path of filesIn(dir)) {
    hash.update(relative(dir, path).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(args: string[], cwd?: string): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) fail(`skills: git ${args.join(" ")} failed\n${run.stderr.trim()}`);
  return run.stdout.trim();
}

function check(): void {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const skill of list.skills) {
    const dir = join(DIR, skill.name);
    if (names.has(skill.name)) problems.push(`${skill.name} is listed twice`);
    names.add(skill.name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      problems.push(`${skill.name} is listed but ${dir}/SKILL.md is missing${skill.source ? " - run `task skills:fetch`" : ""}`);
      continue;
    }
    if (!skill.source) continue;
    const source = list.sources[skill.source];
    if (!source) {
      problems.push(`${skill.name} names the source "${skill.source}", which ${LIST} does not define`);
    } else if (skill.fetched !== source.commit) {
      problems.push(`${skill.name} was copied at ${skill.fetched?.slice(0, 7) ?? "no commit"} but its source is now at ${source.commit.slice(0, 7)} - run \`task skills:fetch\` and commit the result`);
    } else if (hashOf(dir) !== skill.sha256) {
      problems.push(`${dir} differs from what was copied from its source. A copied skill is never edited: undo the change, or run \`task skills:fetch\``);
    }
  }
  if (problems.length > 0) fail(["skills:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  const copied = list.skills.filter((skill) => skill.source).length;
  console.log(`skills:check ok - ${list.skills.length} skills listed, ${copied} copied from their source and unedited`);
}

function fetch(): void {
  for (const [name, source] of Object.entries(list.sources)) {
    const skills = list.skills.filter((skill) => skill.source === name);
    if (skills.length === 0) continue;
    const clone = mkdtempSync(join(tmpdir(), "skills-"));
    try {
      git(["init", "-q"], clone);
      git(["fetch", "-q", "--depth", "1", source.repository, source.commit], clone);
      git(["checkout", "-q", "FETCH_HEAD"], clone);
      for (const skill of skills) {
        const from = join(clone, skill.path ?? "");
        if (!skill.path || !existsSync(join(from, "SKILL.md"))) fail(`skills: ${source.repository} has no skill at "${skill.path}" at ${source.commit.slice(0, 7)} (${skill.name})`);
        const to = join(DIR, skill.name);
        rmSync(to, { recursive: true, force: true });
        cpSync(from, to, { recursive: true });
        for (const file of LICENCE_FILES) {
          if (existsSync(join(clone, file)) && !existsSync(join(to, file))) cpSync(join(clone, file), join(to, file));
        }
        skill.fetched = source.commit;
        skill.sha256 = hashOf(to);
        console.log(`skills: ${skill.name} copied from ${source.repository} at ${source.commit.slice(0, 7)}`);
      }
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }
  save();
}

function update(): void {
  for (const [name, source] of Object.entries(list.sources)) {
    const head = git(["ls-remote", source.repository, `refs/heads/${source.branch}`]).split(/\s/)[0];
    if (!head) fail(`skills: ${source.repository} has no branch "${source.branch}"`);
    if (head !== source.commit) console.log(`skills: ${name} moves from ${source.commit.slice(0, 7)} to ${head!.slice(0, 7)}`);
    source.commit = head!;
  }
  fetch();
}

function add(args: string[]): void {
  const name = args[0];
  if (!name || name.startsWith("--")) fail("skills: say which skill - `task skills:add -- <name>`");
  const option = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (list.skills.some((skill) => skill.name === name)) fail(`skills: ${name} is already listed in ${LIST}`);

  const offered = list.offered.find((skill) => skill.name === name);
  if (args.includes("--manual")) {
    if (!existsSync(join(DIR, name!, "SKILL.md"))) fail(`skills: write ${join(DIR, name!, "SKILL.md")} first, then record it`);
    list.skills.push({ name: name!, owner: "api", for: option("--for") ?? "" });
    save();
    console.log(`skills: ${name} recorded. It has no source, so it is yours to keep up to date.`);
    return;
  }
  if (offered) {
    list.offered = list.offered.filter((skill) => skill.name !== name);
    list.skills.push({ name: name!, owner: "api", for: offered.for, source: offered.source, path: offered.path });
  } else {
    const repository = option("--repository");
    const path = option("--path");
    if (!repository || !path) {
      fail(
        [
          `skills: ${name} is not one the template offers (${list.offered.map((skill) => skill.name).join(", ") || "none"}).`,
          "  From a git repository:  task skills:add -- <name> --repository <git url> --path <directory in it> [--branch main]",
          "  Written by hand:        task skills:add -- <name> --manual",
        ].join("\n"),
      );
    }
    const branch = option("--branch") ?? "main";
    const key = Object.entries(list.sources).find(([, source]) => source.repository === repository)?.[0] ?? name!;
    if (!list.sources[key]) {
      const head = git(["ls-remote", repository!, `refs/heads/${branch}`]).split(/\s/)[0];
      if (!head) fail(`skills: ${repository} has no branch "${branch}"`);
      list.sources[key] = { repository: repository!, branch, commit: head! };
    }
    list.skills.push({ name: name!, owner: "api", for: option("--for") ?? "", source: key, path });
  }
  fetch();
  console.log(`skills: ${name} is in ${join(DIR, name!)}. Commit it with ${LIST}; check its licence allows the copy.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "check") check();
else if (command === "fetch") fetch();
else if (command === "update") update();
else if (command === "add") add(rest);
else fail("skills: check | fetch | update | add <name>");
