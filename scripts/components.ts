// The template's optional components. An API that does not need one removes
// it - its files, its sections of shared files, its skills and its Renovate
// rules - and can bring it back later, as the template has it now.
//   node scripts/components.ts list              - every component, and whether this repository has it
//   node scripts/components.ts remove <name>     - remove one; refused while another that needs it remains
//   node scripts/components.ts add <name>        - restore one from the template, with what it needs
//                                 [--from <git url or path>]  the template to restore from, when not the one in components.json
//   node scripts/components.ts order             - the components still here, in an order they can all be removed
//   node scripts/components.ts gates <stage>     - the gates the components still here add to a stage (spec, implemented, ci)
//   node scripts/components.ts run <stage>       - run them
// What is removed is recorded in .components. Nothing here is a judgement: a
// component is its declaration in components.json and its markers.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Declarations, NAME, RECORD, declarations, owns, removed, split, withSections, withoutSections } from "./components-lib.ts";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

// Renovate rules and skills.json entries cannot carry a comment, so they say
// whose they are in their own data.
const tag = (name: string) => `[component:${name}]`;
type Renovate = { customManagers?: { description?: string }[]; packageRules?: { description?: string }[] } & Record<string, unknown>;
type Skills = { skills: { name: string; component?: string }[]; offered: { name: string; component?: string }[] } & Record<string, unknown>;
const readJson = <T>(path: string): T | null => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null);
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

function git(args: string[], cwd?: string): string {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) stop(`components: git ${args.join(" ")} failed\n${run.stderr.trim()}`);
  return run.stdout.trim();
}

// The text files that carry a marker of this component.
function marked(name: string, kind: "start" | "removed", cwd = "."): string[] {
  const found = spawnSync("git", ["grep", "-l", "-I", "--untracked", "-F", `component:${name}:${kind}`, "--", ".", ":!scripts/components*.ts", ":!test/"], { cwd, encoding: "utf8" });
  return found.stdout.split("\n").filter(Boolean);
}

function record(names: Set<string>): void {
  if (names.size === 0) return rmSync(RECORD, { force: true });
  writeFileSync(RECORD, ["# Components this repository has removed. `task component:add -- <name>` restores one.", ...[...names].sort(), ""].join("\n"));
}

function known(all: Declarations, name: string | undefined): string {
  if (!name || !NAME.test(name) || !all.components[name]) {
    const names = Object.keys(all.components);
    stop(`components: ${name ? `"${name}" is not a component` : "say which component"}. ${names.length > 0 ? `They are: ${names.join(", ")}` : "This repository declares none"}`);
  }
  return name!;
}

function list(): void {
  const all = declarations();
  const gone = removed();
  const names = Object.keys(all.components);
  if (names.length === 0) return console.log("components: this repository declares no optional components");
  for (const name of names) {
    const component = all.components[name]!;
    const needs = component.needs?.length ? ` (needs ${component.needs.join(", ")})` : "";
    console.log(`${gone.has(name) ? "removed" : "present"}  ${name} - ${component.title}${needs}`);
  }
  console.log("task component:remove -- <name> removes one; task component:add -- <name> restores one.");
}

function remove(name: string): void {
  const all = declarations();
  known(all, name);
  const gone = removed();
  if (gone.has(name)) return console.log(`components: ${name} is already removed - nothing to do`);
  const dependents = Object.entries(all.components)
    .filter(([other, component]) => !gone.has(other) && component.needs?.includes(name))
    .map(([other]) => other);
  if (dependents.length > 0) stop(`components: ${dependents.join(", ")} need${dependents.length === 1 ? "s" : ""} ${name}. Remove ${dependents.length === 1 ? "it" : "them"} first, or keep ${name}`);

  const done: string[] = [];
  for (const path of all.components[name]!.files ?? []) {
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true });
    done.push(`deleted ${path}`);
  }
  for (const path of marked(name, "start")) {
    writeFileSync(path, withoutSections(readFileSync(path, "utf8"), name));
    done.push(`removed its section from ${path}`);
  }
  const renovate = readJson<Renovate>("renovate.json");
  if (renovate) {
    const before = JSON.stringify(renovate);
    for (const key of ["customManagers", "packageRules"] as const) {
      if (renovate[key]) renovate[key] = renovate[key]!.filter((rule) => !rule.description?.startsWith(tag(name)));
    }
    if (JSON.stringify(renovate) !== before) {
      writeJson("renovate.json", renovate);
      done.push("removed its rules from renovate.json");
    }
  }
  const skills = readJson<Skills>("skills.json");
  if (skills) {
    const mine = [...skills.skills, ...skills.offered].filter((skill) => skill.component === name);
    for (const skill of skills.skills.filter((candidate) => candidate.component === name)) rmSync(join(".claude", "skills", skill.name), { recursive: true, force: true });
    if (mine.length > 0) {
      skills.skills = skills.skills.filter((skill) => skill.component !== name);
      skills.offered = skills.offered.filter((skill) => skill.component !== name);
      writeJson("skills.json", skills);
      done.push(`removed its skills (${mine.map((skill) => skill.name).join(", ")}) from skills.json`);
    }
  }
  record(new Set([...gone, name]));
  console.log([`components: ${name} is removed`, ...done.map((line) => `  - ${line}`), `  Commit the result. \`task component:add -- ${name}\` brings it back.`].join("\n"));
}

// A list as the template orders it: what this repository already has, plus
// what is being restored, in the template's order; then what only this
// repository has. A repository that changed nothing ends identical to the template.
function merged<T>(theirs: T[], ours: T[], key: (item: T) => string, restoring: (item: T) => boolean): T[] {
  const mine = new Map(ours.map((item) => [key(item), item]));
  const template = new Set(theirs.map(key));
  return [...theirs.filter((item) => mine.has(key(item)) || restoring(item)).map((item) => mine.get(key(item)) ?? item), ...ours.filter((item) => !template.has(key(item)))];
}

// The lines of skeleton.lock as a map from "path" or "path#component" to hash.
function lock(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map();
  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("  ") as [string, string])
      .map(([hash, entry]) => [entry, hash]),
  );
}

function add(name: string, from: string | undefined): void {
  const all = declarations();
  known(all, name);
  const gone = removed();
  if (!gone.has(name)) return console.log(`components: ${name} is already here - nothing to do`);
  // What it needs comes back first, and counts as part of this restore.
  const order: string[] = [];
  const visit = (wanted: string) => {
    if (!gone.has(wanted) || order.includes(wanted)) return;
    for (const needed of all.components[wanted]?.needs ?? []) visit(needed);
    order.push(wanted);
  };
  visit(name);

  const repository = from ?? all.template.repository;
  if (!repository) stop("components: components.json names no template repository to restore from; pass --from <git url or path>");
  const work = mkdtempSync(join(tmpdir(), "components-"));
  try {
    git(["init", "-q", work]);
    git(["fetch", "-q", "--depth", "1", repository, from ? "HEAD" : all.template.branch], work);
    git(["checkout", "-q", "FETCH_HEAD"], work);
    const template = declarations(join(work, "components.json"));
    const theirs = lock(join(work, "skeleton.lock"));
    const ours = lock("skeleton.lock");

    // Everything is worked out before anything is changed.
    const writes = new Map<string, string>();
    const copies: string[] = [];
    const behind = new Set<string>();
    const left: string[] = [];
    for (const wanted of order) {
      const component = template.components[wanted] ?? stop(`components: the template at ${repository} no longer has a component called ${wanted}`);
      for (const path of component.files ?? []) {
        if (existsSync(join(work, path))) copies.push(path);
      }
      for (const path of marked(wanted, "removed")) {
        const source = existsSync(join(work, path)) ? split(readFileSync(join(work, path), "utf8")).sections.get(wanted) : undefined;
        const text = writes.get(path) ?? readFileSync(path, "utf8");
        const restored = source ? withSections(text, wanted, source) : null;
        if (restored === null) {
          left.push(`${path} - the template's ${wanted} section does not line up with this file; add it by hand from ${repository}`);
          continue;
        }
        writes.set(path, restored);
        // A skeleton file must be the template's own outside the component's
        // sections, or the restored section may not fit what surrounds it.
        if (theirs.has(path) && ours.get(path) !== theirs.get(path)) behind.add(path);
      }
    }
    if (behind.size > 0) {
      stop(
        [
          `components: ${name} cannot be restored yet - this repository's skeleton is behind the template in files the component is part of:`,
          ...[...behind].sort().map((path) => `  - ${path}`),
          `  Bring those up to date with ${repository} first. Nothing was changed.`,
        ].join("\n"),
      );
    }

    for (const path of copies) {
      rmSync(path, { recursive: true, force: true });
      mkdirSync(dirname(path), { recursive: true });
      cpSync(join(work, path), path, { recursive: true });
    }
    for (const [path, text] of writes) writeFileSync(path, text);

    const done = [...copies.map((path) => `restored ${path}`), ...[...writes.keys()].map((path) => `restored its section in ${path}`)];
    const tags = order.map(tag);
    const renovate = readJson<Renovate>("renovate.json");
    const theirRenovate = readJson<Renovate>(join(work, "renovate.json"));
    if (renovate && theirRenovate) {
      const before = JSON.stringify(renovate);
      for (const key of ["customManagers", "packageRules"] as const) {
        if (!theirRenovate[key]) continue;
        renovate[key] = merged(
          theirRenovate[key]!,
          renovate[key] ?? [],
          (rule) => rule.description ?? JSON.stringify(rule),
          (rule) => tags.some((prefix) => rule.description?.startsWith(prefix)),
        );
      }
      if (JSON.stringify(renovate) !== before) {
        writeJson("renovate.json", renovate);
        done.push("restored its rules in renovate.json");
      }
    }
    const skills = readJson<Skills>("skills.json");
    const theirSkills = readJson<Skills>(join(work, "skills.json"));
    let copied = false;
    if (skills && theirSkills) {
      const before = JSON.stringify(skills);
      const listed = new Set([...skills.skills, ...skills.offered].map((skill) => skill.name));
      const restoring = (skill: { name: string; component?: string }) => !!skill.component && order.includes(skill.component) && !listed.has(skill.name);
      copied = theirSkills.skills.some(restoring);
      // A copied skill is fetched again below, from the commit this repository pins.
      skills.skills = merged(theirSkills.skills.map((skill) => (restoring(skill) ? { ...skill, fetched: undefined, sha256: undefined } : skill)), skills.skills, (skill) => skill.name, restoring);
      skills.offered = merged(theirSkills.offered, skills.offered, (skill) => skill.name, restoring);
      if (JSON.stringify(skills) !== before) {
        writeJson("skills.json", skills);
        done.push("restored its skills in skills.json");
      }
    }
    record(new Set([...gone].filter((other) => !order.includes(other))));
    if (copied) {
      const fetch = spawnSync(process.execPath, ["--import", "tsx", "scripts/skills.ts", "fetch"], { stdio: "inherit" });
      if (fetch.status !== 0) left.push("its skills are listed but were not copied - run `task skills:fetch`");
    }
    console.log(
      [
        `components: ${order.join(" and ")} restored from ${repository}`,
        ...done.map((line) => `  - ${line}`),
        ...left.map((line) => `  ! ${line}`),
        "  Run `task check`, then commit the result. `task skeleton:lock` is not needed: these are the template's files.",
      ].join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The components still here, each before anything it needs: the order in
// which all of them can be removed. Reversed, the order to restore them.
function order(): string[] {
  const all = declarations();
  const gone = removed();
  const out: string[] = [];
  const visit = (name: string) => {
    if (gone.has(name) || out.includes(name)) return;
    for (const [other, component] of Object.entries(all.components)) if (component.needs?.includes(name)) visit(other);
    out.push(name);
  };
  for (const name of Object.keys(all.components)) visit(name);
  return out;
}

function gates(stage: string): string[] {
  const all = declarations();
  const gone = removed();
  return Object.entries(all.components)
    .filter(([name]) => !gone.has(name))
    .flatMap(([, component]) => component.gates?.[stage] ?? []);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const option = (flag: string) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  if (command === "list") list();
  else if (command === "remove") remove(rest[0] ?? "");
  else if (command === "add") add(rest[0] ?? "", option("--from"));
  else if (command === "order") console.log(order().join("\n"));
  else if (command === "gates") console.log(gates(rest[0] ?? "ci").join("\n"));
  else if (command === "run") {
    for (const gate of gates(rest[0] ?? "ci")) {
      const run = spawnSync("task", [gate], { stdio: "inherit" });
      if (run.status !== 0) process.exit(run.status ?? 1);
    }
  } else stop("components: list | remove <name> | add <name> [--from <git url or path>] | gates <stage> | run <stage>");
} catch (error) {
  if (!(error instanceof Problem)) throw error;
  console.error(error.message);
  process.exit(1);
}
