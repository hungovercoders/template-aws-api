// The template's worked examples, kept on main as overlays - one per phase - and never
// as long-lived branches. examples/<name>/spec/ is what the spec phase adds to the
// template: all of specs/, and the files an API owns that go with it (README.md, .stage,
// http/, messages/, its tags and budget). examples/<name>/implementation/ is what
// implementing that spec adds on top: src/operations, src/domain, src/store, steps, tests.
// Neither holds a skeleton file, so a phase made here always has the template as it is.
//   node scripts/example.ts make <name> <phase> [dir]  - lay the phase over this working tree into dir
//                                                         (default .local/examples/<name>-<phase>), a git
//                                                         repository of its own: run it, change it, task ci there
//   node scripts/example.ts save <name> <phase> [dir]  - write what dir adds to the layer below back into
//                                                         the phase's overlay, after changing it there
//   node scripts/example.ts check                      - gate: every overlay is one the template can lay
//   node scripts/example.ts list                       - the examples and their phases
// `task adopt` deletes examples/: an API made from the template starts from the template phase.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { baseline } from "./spec-baseline.ts";

export const EXAMPLES = "examples";
export const PHASES = ["spec", "implementation"] as const;
export type Phase = (typeof PHASES)[number];
// The stage each phase is at (scripts/check.ts), so `task check` there runs its gates.
const STAGE: Record<Phase, string> = { spec: "spec", implementation: "implemented" };
// The spec phase owns all of specs/: the template's starter contract is not there under it.
const OWNED = "specs/";

const stop = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) stop(`example: git ${args.join(" ")} failed in ${cwd}: ${run.stderr.trim()}`);
  return run.stdout;
};
/** The files of a working tree as git sees them - tracked, or new and not ignored. */
const filesOf = (dir: string) =>
  git(dir, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(dir, path)));
/** Every file under a directory, relative to it. */
function walk(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under)).flatMap((entry) => {
    const path = under ? `${under}/${entry}` : entry;
    return statSync(join(dir, path)).isDirectory() ? walk(dir, path) : [path];
  });
}

/** The files the skeleton holds (skeleton.lock), which no overlay may. */
export function skeletonFiles(root = "."): Set<string> {
  const lock = join(root, "skeleton.lock");
  if (!existsSync(lock)) return new Set();
  return new Set(
    readFileSync(lock, "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((path): path is string => Boolean(path)),
  );
}

// What an API owns at each phase, and so all an overlay may hold (AGENTS.md: the business logic the specs describe).
const OWNS: Record<Phase, RegExp> = {
  spec: /^(specs\/.+|README\.md|\.stage|\.spectral\.yaml|http\/contract\.http|messages\/.+|infra\/(tags|budget)\.auto\.tfvars\.json)$/,
  implementation: /^(README\.md|\.stage|src\/(operations|domain|store|consumers)\/.+|steps\/.+|test\/.+)$/,
};

/** What is wrong with a phase's overlay, given its files and the skeleton's. */
export function overlayProblems(phase: Phase, files: string[], skeleton: Set<string>, stage: string | undefined): string[] {
  const problems: string[] = [];
  for (const path of files) {
    if (skeleton.has(path)) problems.push(`${path} is a skeleton file: change it on main, never in an example`);
    else if (!OWNS[phase].test(path) && !(phase === "implementation" && path.startsWith(OWNED))) problems.push(`${path} is not something an API owns at ${phase}: if it changed on main since the copy was made, make it again (\`task example\`) and redo the change there`);
    if (path === EXAMPLES || path.startsWith(`${EXAMPLES}/`)) problems.push(`${path}: an example does not hold examples`);
  }
  if (phase === "implementation" && files.some((path) => path.startsWith(OWNED))) problems.push(`the implementation phase changes ${OWNED}: the spec is the spec phase's, so change it there`);
  if (phase === "spec" && !files.some((path) => path.startsWith(OWNED))) problems.push(`the spec phase has no ${OWNED}`);
  if (stage !== STAGE[phase]) problems.push(`its .stage is ${JSON.stringify(stage)}; the ${phase} phase is at stage "${STAGE[phase]}"`);
  return problems;
}

/** The phases laid to make `phase`, lowest first. */
const layers = (phase: Phase): Phase[] => PHASES.slice(0, PHASES.indexOf(phase) + 1);
const overlay = (name: string, phase: Phase) => join(EXAMPLES, name, phase);

/** The template alone, at root: its files without examples/. A checkout lists them through git; a tree made from a ref, by walking it. */
function template(root = "."): Map<string, string> {
  const paths = existsSync(join(root, ".git")) ? filesOf(root) : walk(root);
  return new Map(paths.filter((path) => !path.startsWith(`${EXAMPLES}/`)).map((path) => [path, resolve(root, path)]));
}

/** The phase as files: the template at root, and each phase's overlay there laid over it in turn; undefined if root has no such example. */
function layout(name: string, phase: Phase, root = "."): Map<string, string> | undefined {
  const files = template(root);
  for (const layer of layers(phase)) {
    const dir = join(root, overlay(name, layer));
    if (!existsSync(dir)) return undefined;
    if (layer === "spec") for (const path of [...files.keys()]) if (path.startsWith(OWNED)) files.delete(path);
    for (const path of walk(dir)) files.set(path, resolve(dir, path));
  }
  return files;
}

/** Replace what git sees in dir with these files, and commit them. What it ignores - node_modules, .local, Terraform's providers - stays, so a remake is quick. */
function commit(dir: string, files: Map<string, string>, message: string): void {
  for (const path of filesOf(dir)) rmSync(join(dir, path), { force: true });
  for (const [path, from] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(from, join(dir, path));
  }
  git(dir, "add", "--all");
  git(dir, "-c", "user.name=template", "-c", "user.email=template@localhost", "commit", "--quiet", "--allow-empty", "--message", message);
}

function make(name: string, phase: Phase, into: string): void {
  const files = layout(name, phase) ?? stop(`example: ${EXAMPLES}/${name} has no ${phase} phase`);
  if (existsSync(join(into, ".git")) && git(into, "status", "--porcelain").trim() !== "") {
    stop(`example: ${into} has changes not saved to ${overlay(name, phase)} - \`task example:save -- ${name} ${phase}\` keeps them; to throw them away, delete it`);
  }
  // A repository of its own, made afresh: the phase as last published, then as it is here. So the
  // compat gates hold the example's contracts to their versions, as they would any API's.
  rmSync(join(into, ".git"), { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  git(into, "init", "--quiet", "--initial-branch", "main");
  // The repository's own remote, so the `repo` tag and its links name it.
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  if (origin.status === 0) git(into, "remote", "add", "origin", origin.stdout.trim());
  const from = baseline();
  if (from) {
    const published = mkdtempSync(join(tmpdir(), "example-"));
    try {
      const archive = spawnSync("sh", ["-c", `git archive ${from} | tar -x -C "${published}"`], { encoding: "utf8" });
      const before = archive.status === 0 ? layout(name, phase, published) : undefined;
      if (before) commit(into, before, `${name} at ${phase}, as published at ${from.slice(0, 12)}`);
    } finally {
      rmSync(published, { recursive: true, force: true });
    }
  }
  commit(into, files, `${name} at ${phase}, made from this working tree`);
  console.log(`example - ${name} at ${phase} is in ${relative(".", into) || "."} (${files.size} files). There: \`task ${phase === "spec" ? "check" : "ci"}\`, \`task dev\`; after changing it, \`task example:save -- ${name} ${phase}\``);
}

function save(name: string, phase: Phase, from: string): void {
  if (!existsSync(join(from, ".git"))) stop(`example: there is no made copy in ${from} - \`task example -- ${name} ${phase}\` makes one`);
  // The layer below: the template, and for the implementation the spec phase over it.
  const below = phase === "spec" ? template() : (layout(name, "spec") ?? stop(`example: ${EXAMPLES}/${name} has no spec phase`));
  const made = new Set(filesOf(from));
  const missing = [...below.keys()].filter((path) => !made.has(path) && !(phase === "spec" && path.startsWith(OWNED)));
  if (missing.length > 0) stop(`example: the copy in ${from} deletes ${missing.join(", ")}; an example only adds to the template`);
  const changed = [...made].filter((path) => {
    if (phase === "spec" && path.startsWith(OWNED)) return true;
    const was = below.get(path);
    return was === undefined || !readFileSync(was).equals(readFileSync(join(from, path)));
  });
  const stage = made.has(".stage") ? readFileSync(join(from, ".stage"), "utf8").trim() : undefined;
  const problems = overlayProblems(phase, changed, skeletonFiles(), stage);
  if (problems.length > 0) stop(["example: not saved", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  const dir = overlay(name, phase);
  rmSync(dir, { recursive: true, force: true });
  for (const path of changed.sort()) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(from, path), join(dir, path));
  }
  console.log(`example:save - ${dir} holds what ${name} adds at ${phase}: ${changed.length} files. Commit it.`);
}

const names = () => (existsSync(EXAMPLES) ? readdirSync(EXAMPLES).filter((name) => statSync(join(EXAMPLES, name)).isDirectory()).sort() : []);

function check(): void {
  if (names().length === 0) return void console.log(`example:check - no ${EXAMPLES}/, nothing to check`);
  const skeleton = skeletonFiles();
  const problems = names().flatMap((name) => {
    const unknown = readdirSync(join(EXAMPLES, name)).filter((entry) => !(PHASES as readonly string[]).includes(entry));
    return [
      ...unknown.map((entry) => `${EXAMPLES}/${name}/${entry}: not a phase (${PHASES.join(", ")})`),
      ...PHASES.flatMap((phase) => {
        const dir = overlay(name, phase);
        if (!existsSync(dir)) return [`${dir}: missing - an example has every phase`];
        const files = walk(dir);
        const stage = files.includes(".stage") ? readFileSync(join(dir, ".stage"), "utf8").trim() : undefined;
        return overlayProblems(phase, files, skeleton, stage).map((problem) => `${dir}: ${problem}`);
      }),
    ];
  });
  if (problems.length > 0) stop(["example:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  console.log(`example:check ok - ${names().join(", ")}: every phase only adds what an API owns`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, name, phase, dir] = process.argv.slice(2);
  const valid = (value: string | undefined): value is Phase => (PHASES as readonly string[]).includes(value ?? "");
  if (command === "check") check();
  else if (command === "list") for (const example of names()) console.log(`${example}: ${PHASES.join(", ")}`);
  else if ((command === "make" || command === "save") && name && valid(phase)) {
    if (!names().includes(name)) stop(`example: no ${EXAMPLES}/${name} - the examples are ${names().join(", ") || "none"}`);
    const at = dir ?? join(".local", EXAMPLES, `${name}-${phase}`);
    if (command === "make") make(name, phase, at);
    else save(name, phase, at);
  } else stop(`example: say what to do - make|save <name> <${PHASES.join("|")}> [dir], check or list (the examples: ${names().join(", ") || "none"})`);
}
