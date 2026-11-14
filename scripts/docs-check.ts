// Gate: documentation and agent context stay necessary.
//   - nothing outgrows its line budget
//   - every guide says who it is for and when
//   - every link between documents resolves
// To change a budget, change it here - deliberately, after asking what could
// be cut or turned into a gate instead.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const BUDGETS: [pattern: RegExp, lines: number, why: string][] = [
  [/^CLAUDE\.md$/, 80, "read by every agent session"],
  [/^\.claude\/skills\/[^/]+\/SKILL\.md$/, 350, "read whenever the skill runs"],
  [/^README\.md$/, 220, "the front page: the pitch and how to start"],
  [/^CONTRIBUTING\.md$/, 150, "how the template itself is changed"],
  [/^SECURITY\.md$/, 60, "how to report a vulnerability, and what to rely on"],
  [/^docs\/[^/]+\.md$/, 250, "a guide for one reader at one moment"],
];

const files = [
  "CLAUDE.md",
  "README.md",
  ...["CONTRIBUTING.md", "SECURITY.md"].filter(existsSync),
  ...(existsSync("docs") ? readdirSync("docs").filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`) : []),
  ...(existsSync(".claude/skills") ? readdirSync(".claude/skills").map((skill) => `.claude/skills/${skill}/SKILL.md`).filter(existsSync) : []),
].sort();

const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
const anchors = (path: string) => new Set([...readFileSync(path, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]!.trim())));

const problems: string[] = [];
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
