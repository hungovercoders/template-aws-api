// The template's changelog, written from its history - never by hand.
//   node scripts/changelog.ts generate   - write CHANGELOG.md
//   node scripts/changelog.ts check      - gate: CHANGELOG.md is what generate writes
//
// It lists every change merged into the default branch before this one, newest first, by
// the day it was merged and grouped by kind: a pull request by its title, a commit made
// straight on the branch by its subject. "Before this one" is where spec:compat compares
// from (spec-baseline.ts): on a pull request, the default branch; on the default branch
// after a merge, the commit before it. So a pull request carries the changelog of what it
// was built on, and the default branch agrees once it is merged.
//
// It is the template's: on a branch whose .stage is past `template` (an API, the example
// branches) the history is that API's, and `task adopt` deletes the file.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { baseline } from "./spec-baseline.ts";
import { repo } from "./tags.ts";

const FILE = "CHANGELOG.md";

export type Commit = { day: string; subject: string; body: string };
type Entry = { day: string; kind: string; title: string; pull?: number; from?: string };

// Conventional Commits' kinds, in the order the changelog lists them.
const KINDS: [kind: string, heading: string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["ci", "CI"],
  ["build", "Build"],
  ["chore", "Chores"],
];
const OTHER = "Other";

/** What one commit on the default branch says changed, or nothing for a merge that is not a pull request. */
export function entryOf(commit: Commit): Entry | undefined {
  const pull = /^Merge pull request #(\d+) from ([^/\s]+)\//.exec(commit.subject) ?? /^Merge pull request #(\d+)\b/.exec(commit.subject);
  if (!pull && /^Merge (branch|remote-tracking branch|commit) /.test(commit.subject)) return undefined;
  const line = pull ? (commit.body.split("\n").find((text) => text.trim() !== "") ?? commit.subject) : commit.subject;
  const conventional = /^([a-z]+)(\([^)]*\))?!?:\s*(.+)$/.exec(line.trim());
  const known = conventional && KINDS.some(([kind]) => kind === conventional[1]);
  return {
    day: commit.day,
    kind: known ? conventional![1]! : OTHER,
    title: known ? conventional![3]! : line.trim(),
    ...(pull ? { pull: Number(pull[1]), ...(pull[2] ? { from: pull[2] } : {}) } : {}),
  };
}

/**
 * The changelog for these commits, newest first. A pull request links to its page when it was
 * merged from `owner`'s own repository; one that came with history copied from elsewhere keeps
 * its number, unlinked, rather than point at another pull request of the same number here.
 */
export function render(commits: Commit[], owner?: string): string {
  const entries = commits.map(entryOf).filter((entry): entry is Entry => entry !== undefined);
  const lines = [
    "# Changelog",
    "",
    "Every change merged into the template's default branch, newest first. Written by",
    "`task changelog:generate` from the history; `task changelog:check` keeps it current.",
  ];
  for (const day of [...new Set(entries.map((entry) => entry.day))]) {
    lines.push("", `## ${day}`);
    for (const [kind, heading] of [...KINDS, [OTHER, OTHER] as const]) {
      const ofKind = entries.filter((entry) => entry.day === day && entry.kind === kind);
      if (ofKind.length === 0) continue;
      lines.push("", `### ${heading}`, "");
      for (const entry of ofKind) {
        const ours = owner !== undefined && entry.from?.toLowerCase() === owner.toLowerCase();
        lines.push(`- ${entry.title}${entry.pull ? (ours ? ` ([#${entry.pull}](../../pull/${entry.pull}))` : ` (#${entry.pull})`) : ""}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function history(ref: string): Commit[] {
  const log = spawnSync("git", ["log", "--first-parent", "--format=%cs%x1f%s%x1f%b%x1e", ref], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (log.status !== 0) throw new Error(`changelog: git log ${ref} failed: ${log.stderr.trim()}`);
  return log.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [day = "", subject = "", body = ""] = record.split("\x1f");
      return { day, subject, body };
    });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stage = existsSync(".stage") ? readFileSync(".stage", "utf8").trim() : "implemented";
  if (stage !== "template") {
    console.log(`changelog - the changelog is the template's; this branch is an API's (stage ${stage}), with a history of its own`);
    process.exit(0);
  }
  const from = baseline();
  if (!from) {
    console.error("changelog: there is no history to write it from - fetch the default branch (git fetch origin main)");
    process.exit(1);
  }
  // The owner of this repository, from its git remote or GitHub Actions (tags.ts).
  const owner = new URL(repo()).pathname.split("/").filter(Boolean).at(-2);
  const wanted = render(history(from), owner);
  if (process.argv[2] === "generate") {
    writeFileSync(FILE, wanted);
    console.log(`changelog:generate - ${FILE} written from the history up to ${from.slice(0, 12)}`);
  } else {
    const current = existsSync(FILE) ? readFileSync(FILE, "utf8") : "";
    if (current !== wanted) {
      console.error(`changelog:check failed - ${FILE} is not what the history up to ${from.slice(0, 12)} says; run \`task changelog:generate\` and commit it (after merging the default branch in, if it has moved)`);
      process.exit(1);
    }
    console.log(`changelog:check ok - ${FILE} describes the history up to ${from.slice(0, 12)}`);
  }
}
