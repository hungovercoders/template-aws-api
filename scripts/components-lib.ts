// What the skeleton knows about optional components, shared by
// scripts/components.ts (which removes and restores them) and
// scripts/skeleton.ts (which holds what remains to skeleton.lock).
//
// A component owns whole files, listed in components.json, and marked
// sections of files it shares with the rest of the skeleton:
//     # component:<name>:start        (#, //, <!-- --> or mermaid's %%; the marker is the text)
//     ...
//     # component:<name>:end
// Removing a component deletes its files and replaces each section with one
// line, `component:<name>:removed`, which is where restoring puts it back.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const DECLARATIONS = "components.json";
// The components this repository has removed, one name per line. Absent: none.
export const RECORD = ".components";
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type Component = { title: string; needs?: string[]; files?: string[]; gates?: Record<string, string[]> };
export type Declarations = { template: { repository: string; branch: string }; components: Record<string, Component> } & Record<string, unknown>;

export function declarations(path = DECLARATIONS): Declarations {
  if (!existsSync(path)) return { template: { repository: "", branch: "main" }, components: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Declarations;
}

export function removed(path = RECORD): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

const MARKER = /component:([a-z0-9][a-z0-9-]*):(start|end|removed)\b/;
// A marker is a comment on a line of its own, so nothing else can ride on one
// and be left out of what skeleton.lock holds.
const ALONE = /^\s*(#|\/\/|<!--|%%)\s*component:[a-z0-9][a-z0-9-]*:(start|end|removed)\s*(-->)?\s*$/;

export type Parts = {
  // The file without any component's sections or placeholders.
  core: string;
  // Each component's sections in this file, in order, markers included.
  sections: Map<string, string[]>;
  // How many placeholders each removed component has left in this file.
  placeholders: Map<string, number>;
  // A start with no end, an end with no start, or one section inside another.
  problems: string[];
};

export function split(text: string): Parts {
  const parts: Parts = { core: "", sections: new Map(), placeholders: new Map(), problems: [] };
  const core: string[] = [];
  let open: { name: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line);
    if (marker && !ALONE.test(line)) parts.problems.push(`component:${marker[1]}:${marker[2]} shares its line with something else; a marker is a comment on its own line`);
    if (open) {
      open.lines.push(line);
      if (marker?.[2] === "end" && marker[1] === open.name) {
        parts.sections.set(open.name, [...(parts.sections.get(open.name) ?? []), open.lines.join("\n")]);
        open = null;
      } else if (marker) {
        parts.problems.push(`component:${marker[1]}:${marker[2]} inside the section of ${open.name}`);
      }
    } else if (marker?.[2] === "start") {
      open = { name: marker[1]!, lines: [line] };
    } else if (marker?.[2] === "removed") {
      parts.placeholders.set(marker[1]!, (parts.placeholders.get(marker[1]!) ?? 0) + 1);
    } else if (marker) {
      parts.problems.push(`component:${marker[1]}:end with no start`);
    } else {
      core.push(line);
    }
  }
  if (open) parts.problems.push(`component:${open.name}:start with no end`);
  parts.core = core.join("\n");
  return parts;
}

// Replace each of the component's sections with its one-line placeholder,
// written in the comment syntax of the start line it replaces.
export function withoutSections(text: string, name: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line);
    if (skipping) {
      if (marker?.[1] === name && marker[2] === "end") skipping = false;
    } else if (marker?.[1] === name && marker[2] === "start") {
      out.push(line.replace(`component:${name}:start`, `component:${name}:removed`));
      skipping = true;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

// Put the component's sections, as the template has them, back where its
// placeholders are. Returns null when the two do not line up.
export function withSections(text: string, name: string, sections: string[]): string | null {
  const out: string[] = [];
  let next = 0;
  for (const line of text.split("\n")) {
    const marker = MARKER.exec(line);
    if (marker?.[1] === name && marker[2] === "removed") {
      const section = sections[next++];
      if (section === undefined) return null;
      out.push(section);
    } else {
      out.push(line);
    }
  }
  return next === sections.length ? out.join("\n") : null;
}

// Whether a path is one of the files or directories the component owns.
export function owns(component: Component, path: string): boolean {
  return (component.files ?? []).some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned));
}

// The lines of a skeleton.lock as a map from "path" or "path#component" to hash.
export function lock(path = "skeleton.lock"): Map<string, string> {
  if (!existsSync(path)) return new Map();
  return new Map(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("  ") as [string, string])
      .map(([hash, entry]) => [entry, hash]),
  );
}

// The gates the components still in this repository add to a stage.
export function gates(stage: string): string[] {
  const gone = removed();
  return Object.entries(declarations().components)
    .filter(([name]) => !gone.has(name))
    .flatMap(([, component]) => component.gates?.[stage] ?? []);
}

// git, away from whatever repository a hook or a caller exported: these
// scripts run git in temporary directories, which must never be read as the
// developer's own.
export function git(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX)$/.test(name)));
  const run = spawnSync("git", args, { cwd, encoding: "utf8", env });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}
