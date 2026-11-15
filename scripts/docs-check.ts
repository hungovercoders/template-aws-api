// Gate: documentation and agent context stay necessary.
//   - nothing outgrows its line budget
//   - every guide says who it is for and when
//   - every link between documents resolves
// To change a budget, change it here - deliberately, after asking what could
// be cut or turned into a gate instead.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const BUDGETS: [pattern: RegExp, lines: number, why: string][] = [
  [/^AGENTS\.md$/, 80, "read by every agent session"],
  [/^CLAUDE\.md$/, 15, "imports AGENTS.md; holds only what is specific to Claude Code"],
  [/^\.claude\/skills\/[^/]+\/SKILL\.md$/, 350, "read whenever the skill runs"],
  [/^\.claude\/skills\/[^/]+\/(?!SKILL\.md$)[^/]+\.md$/, 80, "read with the skill, when the part of the API it is about is present"],
  [/^README\.md$/, 260, "the front page: the pitch, the architecture and how to start"],
  [/^CONTRIBUTING\.md$/, 150, "how the template itself is changed"],
  [/^SECURITY\.md$/, 60, "how to report a vulnerability, and what to rely on"],
  [/^docs\/[^/]+\.md$/, 250, "a guide for one reader at one moment"],
];

// A skill copied from its source (skills.json) is not ours to cut or to fix
// links in, and `task skills:check` already holds it unedited. An agent reads
// its SKILL.md only when the task calls for it, so it is not standing context.
const copied = new Set<string>(
  existsSync("skills.json") ? (JSON.parse(readFileSync("skills.json", "utf8")) as { skills: { name: string; source?: string }[] }).skills.filter((skill) => skill.source).map((skill) => skill.name) : [],
);

const files = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  ...["CONTRIBUTING.md", "SECURITY.md"].filter(existsSync),
  ...(existsSync("docs") ? readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`) : []),
  ...(existsSync(".claude/skills")
    ? readdirSync(".claude/skills")
        .filter((skill) => !copied.has(skill))
        .flatMap((skill) => readdirSync(`.claude/skills/${skill}`).filter((file) => file.endsWith(".md")).map((file) => `.claude/skills/${skill}/${file}`))
    : []),
].sort();

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
const anchors = (path: string) => new Set([...readFileSync(path, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!.trim())));

const problems: string[] = [];
// One copy of the agent instructions: CLAUDE.md imports AGENTS.md rather than repeating it.
if (!/^@AGENTS\.md$/m.test(readFileSync("CLAUDE.md", "utf8"))) {
  problems.push("CLAUDE.md does not import AGENTS.md (a line reading exactly @AGENTS.md)");
}
for (const path of files) {
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").length - 1;
  const budget = BUDGETS.find(([pattern]) => pattern.test(path));
  if (budget && lines > budget[1]) {
    problems.push(`${path} is ${lines} lines; its budget is ${budget[1]} (${budget[2]}). Cut it, or turn part of it into a gate.`);
  }
  if (path.startsWith("docs/") && !/^> \*\*For\*\* .+\*\*When\*\* .+/m.test(text.split("\n").slice(0, 6).join("\n"))) {
    problems.push(`${path} does not open with a "> **For** ... **When** ..." line saying who it is for and when they need it`);
  }
  // Fenced code is not prose: links inside it are examples.
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
    // Web links, and links that only mean something on GitHub (../../tree/...), are not checked.
    if (/^(https?:|mailto:)/.test(target!) || target!.startsWith("../../")) continue;
    const [file, anchor] = target!.split("#") as [string, string | undefined];
    const resolved = file === "" ? path : normalize(join(dirname(path), file));
    if (!existsSync(resolved)) {
      problems.push(`${path} links to ${target}, which does not exist`);
    } else if (anchor && resolved.endsWith(".md") && !anchors(resolved).has(anchor)) {
      problems.push(`${path} links to ${target}, but ${resolved} has no heading "${anchor}"`);
    }
  }
}

if (problems.length > 0) {
  console.error("docs:check failed\n" + problems.map((problem) => `  - ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`docs:check ok - ${files.length} documents within budget, links resolve`);
