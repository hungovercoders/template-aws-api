// Skills that come from somewhere else - AWS's, or one for a service this API
// integrates with - are copied into .claude/skills/ so every clone and every
// agent has them, and are never edited here. skills.json lists every skill in
// that directory and, for a copied one, where it came from and at which commit.
//   node scripts/skills.ts check             - gate: every skill is listed; every copied one is present, unedited and at its source's commit
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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIST = "skills.json";
const DIR = ".claude/skills";
// A licence that lets a skill be copied asks that it travels with the copy.
const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "NOTICE", "NOTICE.md", "NOTICE.txt"];
// A skill's name is also a directory that fetch replaces, so it is never a path.
const NAME = /^[a-z0-9][a-z0-9-]*$/;

type Source = { repository: string; branch: string; commit: string };
type Skill = { name: string; owner: "template" | "api"; for: string; source?: string; path?: string; fetched?: string; sha256?: string };
type Offered = { name: string; source: string; path: string; for: string; when: string };
type List = { sources: Record<string, Source>; skills: Skill[]; offered: Offered[]; integrations: unknown[] } & Record<string, unknown>;

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

const list = JSON.parse(readFileSync(LIST, "utf8")) as List;
const save = () => writeFileSync(LIST, JSON.stringify(list, null, 2) + "\n");

function git(args: string[], cwd?: string): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) stop(`skills: git ${args.join(" ")} failed\n${run.stderr.trim()}`);
  return run.stdout.trim();
}

// Every file under dir as a path relative to it, with forward slashes. In the
// repository that is git's view of it, so a stray ignored file (an editor's
// backup, .DS_Store) is not part of the skill; a fresh copy has no such files.
function filesIn(dir: string, tracked: boolean): string[] {
  if (tracked) {
    const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", dir], { encoding: "utf8" });
    if (listed.status === 0) {
      return listed.stdout
        .split("\n")
        .filter((path) => path && existsSync(path) && statSync(path).isFile())
        .map((path) => path.slice(dir.length + 1))
        .sort();
    }
  }
  const walk = (at: string): string[] =>
    readdirSync(join(dir, at), { withFileTypes: true }).flatMap((entry) => {
      const path = at ? `${at}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
    });
  return walk("").sort();
}

// One hash for a skill's whole directory: every file's path and content. Line
// endings are read as LF, so a checkout that converts them hashes the same.
function hashOf(dir: string, tracked: boolean): string {
  const hash = createHash("sha256");
  for (const path of filesIn(dir, tracked)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(dir, path), "utf8").replace(/\r\n/g, "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function check(): void {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const skill of list.skills) {
    const dir = `${DIR}/${skill.name}`;
    if (!NAME.test(skill.name)) problems.push(`"${skill.name}" is not a skill name (lower case letters, digits and hyphens)`);
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
    } else if (hashOf(dir, true) !== skill.sha256) {
      problems.push(`${dir} differs from what was copied from its source. A copied skill is never edited: undo the change, or run \`task skills:fetch\``);
    }
  }
  // A skill is standing context for every session, so none is here unrecorded.
  for (const entry of existsSync(DIR) ? readdirSync(DIR, { withFileTypes: true }) : []) {
    if (entry.isDirectory() && !names.has(entry.name)) {
      problems.push(`${DIR}/${entry.name} is not listed in ${LIST}. If the owner wants it, record it: \`task skills:add -- ${entry.name} --manual\`; otherwise remove it`);
    }
  }
  if (problems.length > 0) stop(["skills:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  const copied = list.skills.filter((skill) => skill.source).length;
  console.log(`skills:check ok - ${list.skills.length} skills listed, ${copied} copied from their source and unedited`);
}

// Copy the named skills (all copied ones when none is named). Every copy is
// made and checked in a temporary directory first; only when all of them are
// ready are the skill directories and skills.json changed.
function fetch(only?: string[]): void {
  const wanted = list.skills.filter((skill) => skill.source && (!only || only.includes(skill.name)));
  const work = mkdtempSync(join(tmpdir(), "skills-"));
  try {
    const ready: { skill: Skill; staged: string; commit: string }[] = [];
    for (const name of new Set(wanted.map((skill) => skill.source!))) {
      const source = list.sources[name] ?? stop(`skills: ${LIST} lists a skill from the source "${name}", which it does not define`);
      const clone = join(work, `clone-${ready.length}`);
      git(["init", "-q", clone]);
      git(["fetch", "-q", "--depth", "1", source.repository, source.commit], clone);
      git(["checkout", "-q", "FETCH_HEAD"], clone);
      for (const skill of wanted.filter((candidate) => candidate.source === name)) {
        if (!NAME.test(skill.name)) stop(`skills: "${skill.name}" is not a skill name (lower case letters, digits and hyphens)`);
        const from = join(clone, skill.path ?? "");
        if (!skill.path || skill.path.split("/").includes("..") || !existsSync(join(from, "SKILL.md"))) {
          stop(`skills: ${source.repository} has no skill at "${skill.path}" at ${source.commit.slice(0, 7)} (${skill.name})`);
        }
        const staged = join(work, `staged-${skill.name}`);
        cpSync(from, staged, { recursive: true });
        for (const file of LICENCE_FILES) {
          if (existsSync(join(clone, file)) && !existsSync(join(staged, file))) cpSync(join(clone, file), join(staged, file));
        }
        ready.push({ skill, staged, commit: source.commit });
      }
    }
    for (const { skill, staged, commit } of ready) {
      const to = `${DIR}/${skill.name}`;
      rmSync(to, { recursive: true, force: true });
      try {
        renameSync(staged, to);
      } catch {
        // The temporary directory can be on another device.
        cpSync(staged, to, { recursive: true });
      }
      skill.fetched = commit;
      skill.sha256 = hashOf(to, true);
      console.log(`skills: ${skill.name} copied from ${list.sources[skill.source!]!.repository} at ${commit.slice(0, 7)}`);
    }
    save();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function head(repository: string, branch: string): string {
  return git(["ls-remote", repository, `refs/heads/${branch}`]).split(/\s/)[0] || stop(`skills: ${repository} has no branch "${branch}"`);
}

function update(): void {
  for (const [name, source] of Object.entries(list.sources)) {
    const latest = head(source.repository, source.branch);
    if (latest !== source.commit) console.log(`skills: ${name} moves from ${source.commit.slice(0, 7)} to ${latest.slice(0, 7)}`);
    source.commit = latest;
  }
  fetch();
}

function add(args: string[]): void {
  const name = args[0] ?? "";
  if (!NAME.test(name)) stop("skills: say which skill - `task skills:add -- <name>` (lower case letters, digits and hyphens)");
  const option = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (list.skills.some((skill) => skill.name === name)) stop(`skills: ${name} is already listed in ${LIST}`);
  const dir = `${DIR}/${name}`;

  if (args.includes("--manual")) {
    if (!existsSync(join(dir, "SKILL.md"))) stop(`skills: write ${dir}/SKILL.md first, then record it`);
    list.skills.push({ name, owner: "api", for: option("--for") ?? "" });
    save();
    console.log(`skills: ${name} recorded. It has no source, so it is yours to keep up to date.`);
    return;
  }
  // Copying replaces the directory, so it must not already hold something.
  if (existsSync(dir)) stop(`skills: ${dir} already exists and is not listed. Record it as it is with --manual, or remove it first`);

  const offered = list.offered.find((skill) => skill.name === name);
  if (offered) {
    list.offered = list.offered.filter((skill) => skill.name !== name);
    list.skills.push({ name, owner: "api", for: offered.for, source: offered.source, path: offered.path });
  } else {
    const repository = option("--repository");
    const path = option("--path");
    if (!repository || !path) {
      stop(
        [
          `skills: ${name} is not one the template offers (${list.offered.map((skill) => skill.name).join(", ") || "none"}).`,
          "  From a git repository:  task skills:add -- <name> --repository <git url> --path <directory in it> [--branch main]",
          "  Written by hand:        task skills:add -- <name> --manual",
        ].join("\n"),
      );
    }
    const branch = option("--branch") ?? "main";
    let key = Object.entries(list.sources).find(([, source]) => source.repository === repository)?.[0];
    if (key && option("--branch") && list.sources[key]!.branch !== branch) {
      stop(`skills: ${repository} is already a source, on the branch "${list.sources[key]!.branch}". One repository is followed on one branch`);
    }
    if (!key) {
      key = name;
      for (let n = 2; list.sources[key]; n++) key = `${name}-${n}`;
      list.sources[key] = { repository: repository!, branch, commit: head(repository!, branch) };
    }
    list.skills.push({ name, owner: "api", for: option("--for") ?? "", source: key, path });
  }
  fetch([name]);
  console.log(`skills: ${name} is in ${dir}. Commit it with ${LIST}; check its licence allows the copy.`);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "check") check();
  else if (command === "fetch") fetch();
  else if (command === "update") update();
  else if (command === "add") add(rest);
  else stop("skills: check | fetch | update | add <name>");
} catch (error) {
  if (!(error instanceof Problem)) throw error;
  console.error(error.message);
  process.exit(1);
}
