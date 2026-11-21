// The optional-component mechanism (scripts/components.ts), proven on a
// fixture: a small "template" repository with two components, and an "API"
// made from it. No component of the real template is involved, so this holds
// whichever of them a repository has kept.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { split, withSections, withoutSections } from "../scripts/components-lib.ts";

const scripts = resolve("scripts");
const tsx = import.meta.resolve("tsx");
const root = mkdtempSync(join(tmpdir(), "components-test-"));
const template = join(root, "template");

// The fixtures are repositories of their own. When this runs from a git hook,
// git has exported which repository it is in; nothing here may act on that one.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), NODE_OPTIONS: "" };
const run = (cwd: string, script: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, ["--import", tsx, join(scripts, script), ...args], { cwd, encoding: "utf8", env });
  return { status: result.status, output: result.stdout + result.stderr };
};
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (cwd: string) => {
  git(cwd, "init", "-q");
  // Whatever happens, never the repository these tests live in.
  expect(resolve(git(cwd, "rev-parse", "--show-toplevel"))).not.toBe(resolve("."));
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "fixture");
};
const write = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
// Every file but git's own, with its content.
const tree = (cwd: string, at = ""): Record<string, string> =>
  Object.fromEntries(
    readdirSync(join(cwd, at), { withFileTypes: true })
      .filter((entry) => entry.name !== ".git")
      .flatMap((entry) => {
        const path = at ? `${at}/${entry.name}` : entry.name;
        return entry.isDirectory() ? Object.entries(tree(cwd, path)) : [[path, readFileSync(join(cwd, path), "utf8")] as [string, string]];
      }),
  );
// A repository made from the template, as `Use this template` makes one.
const api = (name: string) => {
  const dir = join(root, name);
  cpSync(template, dir, { recursive: true, filter: (path) => !path.endsWith(".git") });
  commit(dir);
  return dir;
};

beforeAll(() => {
  write(
    template,
    "components.json",
    JSON.stringify({
      template: { repository: template, branch: "main" },
      components: {
        demo: { title: "A demo component", files: ["infra/demo.tf", "src/lib/demo/"], gates: { spec: ["demo:check"], ci: ["demo:ci"] } },
        "demo-data": { title: "Needs the demo", needs: ["demo"], files: ["infra/demo-data.tf"] },
      },
    }),
  );
  write(template, "Taskfile.yml", ["vars:", "  CORE: 1", "  # component:demo:start", "  DEMO: 1", "  # component:demo:end", "tasks: {}", ""].join("\n"));
  write(template, "infra/main.tf", "# core\n");
  write(template, "infra/demo.tf", "# demo\n");
  write(template, "infra/demo-data.tf", "# demo data\n");
  write(template, "src/lib/demo/index.ts", "export const demo = 1;\n");
  write(
    template,
    "AGENTS.md",
    ["# Fixture", "", "<!-- component:demo:start -->", "- the demo", "<!-- component:demo:end -->", "<!-- component:demo-data:start -->", "- its data", "<!-- component:demo-data:end -->", "- always", ""].join("\n"),
  );
  write(
    template,
    "renovate.json",
    JSON.stringify({ packageRules: [{ description: "everyone's" }, { description: "[component:demo-data] its tool" }], customManagers: [{ description: "[component:demo] its pin" }] }, null, 2) + "\n",
  );
  write(
    template,
    "skills.json",
    JSON.stringify({ sources: {}, skills: [], offered: [{ name: "kept", for: "all" }, { name: "demo-skill", component: "demo", for: "the demo" }], integrations: [] }, null, 2) + "\n",
  );
  // The lock records git's view of the skeleton, so the repository comes first.
  git(template, "init", "-q");
  expect(run(template, "skeleton.ts", "lock").output).toContain("7 files recorded");
  commit(template);
  git(template, "branch", "-M", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a component another still needs is not removed, and nothing changes", () => {
  const dir = api("refused");
  const before = tree(dir);
  const removal = run(dir, "components.ts", "remove", "demo");
  expect(removal.status).toBe(1);
  expect(removal.output).toContain("demo-data needs demo");
  expect(tree(dir)).toEqual(before);
});

test("removing a component takes its files, sections, rules and skills, and the skeleton still matches its lock", () => {
  const dir = api("removed");
  expect(run(dir, "components.ts", "remove", "demo-data").status).toBe(0);
  expect(run(dir, "components.ts", "remove", "demo").status).toBe(0);

  expect(existsSync(join(dir, "infra/demo.tf"))).toBe(false);
  expect(existsSync(join(dir, "infra/demo-data.tf"))).toBe(false);
  expect(existsSync(join(dir, "src/lib/demo"))).toBe(false);
  expect(existsSync(join(dir, "infra/main.tf"))).toBe(true);
  expect(readFileSync(join(dir, "Taskfile.yml"), "utf8")).toBe(["vars:", "  CORE: 1", "  # component:demo:removed", "tasks: {}", ""].join("\n"));
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(["# Fixture", "", "<!-- component:demo:removed -->", "<!-- component:demo-data:removed -->", "- always", ""].join("\n"));
  const renovate = JSON.parse(readFileSync(join(dir, "renovate.json"), "utf8"));
  expect(renovate.packageRules).toEqual([{ description: "everyone's" }]);
  expect(renovate.customManagers).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, "skills.json"), "utf8")).offered).toEqual([{ name: "kept", for: "all" }]);
  expect(readFileSync(join(dir, ".components"), "utf8")).toContain("demo\ndemo-data\n");

  // No `skeleton:lock`: the lock is the template's, and it still holds.
  const check = run(dir, "skeleton.ts", "check");
  expect(check.output).toContain("skeleton:check ok");
  expect(run(dir, "components.ts", "gates", "ci").output.trim()).toBe("");

  const again = run(dir, "components.ts", "remove", "demo");
  expect(again.status).toBe(0);
  expect(again.output).toContain("already removed");
});

test("what was generated for the components there were is cleared when one is removed or restored", () => {
  const dir = api("generated");
  write(dir, "src/generated/demo.ts", "export {};\n");
  expect(run(dir, "components.ts", "remove", "demo-data").status).toBe(0);
  expect(existsSync(join(dir, "src/generated"))).toBe(false);
  commit(dir);
  write(dir, "src/generated/demo.ts", "export {};\n");
  expect(run(dir, "components.ts", "add", "demo-data", "--from", template).status).toBe(0);
  expect(existsSync(join(dir, "src/generated"))).toBe(false);
});

test("a removed component's file that comes back is caught by the skeleton gate", () => {
  const dir = api("stray");
  run(dir, "components.ts", "remove", "demo-data");
  write(dir, "infra/demo-data.tf", "# written by hand\n");
  const check = run(dir, "skeleton.ts", "check");
  expect(check.status).toBe(1);
  expect(check.output).toContain("still here: infra/demo-data.tf");
});

test("restoring a component brings back what it needs too, and ends identical to never having removed it", () => {
  const dir = api("restored");
  const before = tree(dir);
  run(dir, "components.ts", "remove", "demo-data");
  run(dir, "components.ts", "remove", "demo");
  expect(tree(dir)).not.toEqual(before);

  const restore = run(dir, "components.ts", "add", "demo-data");
  expect(restore.output).toContain("demo and demo-data restored");
  expect(restore.status).toBe(0);
  const after = tree(dir);
  expect(after).toEqual(before);
  expect(run(dir, "skeleton.ts", "check").output).toContain("skeleton:check ok");
  expect(run(dir, "components.ts", "gates", "ci").output.trim()).toBe("demo:ci");
  expect(run(dir, "components.ts", "order").output.trim()).toBe("demo-data\ndemo");
});

test("a component is not restored into a skeleton that has fallen behind the template, and nothing changes", () => {
  const dir = api("behind");
  run(dir, "components.ts", "remove", "demo-data");
  run(dir, "components.ts", "remove", "demo");
  // This repository changed a skeleton file the component is part of, on purpose.
  writeFileSync(join(dir, "Taskfile.yml"), readFileSync(join(dir, "Taskfile.yml"), "utf8").replace("CORE: 1", "CORE: 2"));
  expect(run(dir, "skeleton.ts", "lock").status).toBe(0);
  const before = tree(dir);

  const restore = run(dir, "components.ts", "add", "demo");
  expect(restore.status).toBe(1);
  expect(restore.output).toContain("behind the template");
  expect(restore.output).toContain("Taskfile.yml");
  expect(tree(dir)).toEqual(before);
});

test("a component the template has changed since is not restored, and nothing changes", () => {
  const dir = api("changed-upstream");
  run(dir, "components.ts", "remove", "demo-data");
  const before = tree(dir);
  // A later template: the component's own file is different there.
  const later = join(root, "later-template");
  cpSync(template, later, { recursive: true, filter: (path) => !path.endsWith(".git") });
  write(later, "infra/demo-data.tf", "# demo data, improved\n");
  git(later, "init", "-q");
  run(later, "skeleton.ts", "lock");
  commit(later);

  const restore = run(dir, "components.ts", "add", "demo-data", "--from", later);
  expect(restore.status).toBe(1);
  expect(restore.output).toContain("infra/demo-data.tf");
  expect(restore.output).toContain("Nothing was changed");
  expect(tree(dir)).toEqual(before);
});

test("a placeholder that stands for nothing removed does not hide a line from the skeleton gate", () => {
  const dir = api("smuggled");
  writeFileSync(join(dir, "Taskfile.yml"), readFileSync(join(dir, "Taskfile.yml"), "utf8").replace("tasks: {}", "  # component:x:removed\ntasks: {}"));
  expect(run(dir, "skeleton.ts", "check").output).toContain("component:x:removed is not a section this repository removed");
  writeFileSync(join(dir, "Taskfile.yml"), readFileSync(join(dir, "Taskfile.yml"), "utf8").replace("  # component:x:removed", "  EXTRA: 1 # component:demo:removed"));
  const check = run(dir, "skeleton.ts", "check");
  expect(check.status).toBe(1);
  expect(check.output).toContain("shares its line with something else");
});

test("a section whose end marker is missing is not removed, and nothing changes", () => {
  const dir = api("unpaired");
  writeFileSync(join(dir, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md"), "utf8").replace("<!-- component:demo-data:end -->\n", ""));
  const before = tree(dir);
  const removal = run(dir, "components.ts", "remove", "demo-data");
  expect(removal.status).toBe(1);
  expect(removal.output).toContain("do not pair up");
  expect(tree(dir)).toEqual(before);
});

test("the template to restore from can be given as a path relative to the repository", () => {
  const dir = api("relative");
  run(dir, "components.ts", "remove", "demo-data");
  const restore = run(dir, "components.ts", "add", "demo-data", "--from", "../template");
  expect(restore.output).toContain("demo-data restored");
  expect(restore.status).toBe(0);
  expect(run(dir, "components.ts", "add", "demo-data", "--from").output).toContain("--from needs a value");
});

test("an unknown component is named as such", () => {
  const dir = api("unknown");
  const removal = run(dir, "components.ts", "remove", "nope");
  expect(removal.status).toBe(1);
  expect(removal.output).toContain("They are: demo, demo-data");
});

test("sections are replaced by one placeholder each and restored in order", () => {
  const text = ["a", "# component:x:start", "one", "# component:x:end", "b", "// component:x:start", "two", "// component:x:end", "c"].join("\n");
  const without = withoutSections(text, "x");
  expect(without).toBe(["a", "# component:x:removed", "b", "// component:x:removed", "c"].join("\n"));
  expect(withSections(without, "x", split(text).sections.get("x")!)).toBe(text);
  expect(withSections(without, "x", ["only one"])).toBeNull();
  expect(split(text).core).toBe("a\nb\nc");
  expect(split(without).core).toBe("a\nb\nc");
  expect(split("# component:x:start\nnever closed").problems).toEqual(["component:x:start with no end"]);
});

test("a section of a mermaid diagram is marked with mermaid's own comment, so the diagram still renders", () => {
  const text = ["flowchart TB", "  a --> b", "  %% component:x:start", "  b --> c", "  %% component:x:end", "  a --> d"].join("\n");
  expect(split(text).problems).toEqual([]);
  const without = withoutSections(text, "x");
  expect(without).toBe(["flowchart TB", "  a --> b", "  %% component:x:removed", "  a --> d"].join("\n"));
  expect(withSections(without, "x", split(text).sections.get("x")!)).toBe(text);
});
