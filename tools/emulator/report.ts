// What `task emulator:gaps` says, kept apart from the tests so it can be
// tested itself (test/emulator-gaps.test.ts) without an emulator or a client.

export type Result = "still-needed" | "closed" | "unknown";

/** A gap as it is listed and reported: everything about it but its test. */
export type Listed = { id: string; kind: "workaround" | "limit" | "blocked"; gap: string; then: string; where: string[]; issue?: number };
export type Outcome = Listed & { result: Result; detail?: string; seconds: number };

/** A gap is this repository's while any file it names is here: a removed component takes its files, and so its gaps. */
export function applies(gap: Pick<Listed, "where">, exists: (path: string) => boolean): boolean {
  return gap.where.some(exists);
}

const SAYS: Record<Result, string> = { "still-needed": "still needed", closed: "the gap has closed", unknown: "could not tell" };

export function line(outcome: Outcome): string {
  return `${SAYS[outcome.result].padEnd(19)} ${outcome.id.padEnd(30)} ${outcome.kind.padEnd(10)} ${outcome.seconds.toFixed(0).padStart(3)}s`;
}

/** What to do about a gap that has closed, by kind. */
export function next(outcome: Listed): string {
  if (outcome.kind === "workaround") return "Remove the workaround";
  if (outcome.kind === "blocked") return `Unblock #${outcome.issue}`;
  return "Bring the testing guide up to date";
}

export function report(outcomes: Outcome[], version: string): string {
  const closed = outcomes.filter((outcome) => outcome.result === "closed");
  const unknown = outcomes.filter((outcome) => outcome.result === "unknown");
  const lines = [`AWS Emulator ${version}: ${outcomes.length} gaps tested`, "", ...outcomes.map(line)];
  for (const outcome of closed) lines.push("", `${outcome.id}: the gap has closed. ${next(outcome)}.`, `  was: ${outcome.gap}`, `  now: ${outcome.then}`, `  in:  ${outcome.where.join(", ")}`);
  for (const outcome of unknown) lines.push("", `${outcome.id}: could not tell - the test failed before it reached the gap.`, ...(outcome.detail ?? "").split("\n").map((text) => `  ${text}`));
  lines.push("", closed.length === 0 ? "Nothing to remove: every gap is still there." : `${closed.length} closed. Each is its own change; none of them is urgent.`);
  return lines.join("\n");
}

/** The same, for a pull request's checks page. */
export function summary(outcomes: Outcome[], version: string): string {
  const rows = outcomes.map((outcome) => `| \`${outcome.id}\` | ${outcome.kind} | ${SAYS[outcome.result]} | ${outcome.result === "closed" ? `${next(outcome)}: ${outcome.then}` : outcome.gap} |`);
  return [`### Emulator gaps on AWS Emulator ${version}`, "", "| Gap | Kind | Result | |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

/** One issue for a closed gap. The title is how a second run finds the first one's issue, so it names no version. */
export function issue(outcome: Outcome, version: string): { title: string; body: string } {
  const lines = [
    `\`task emulator:gaps\` found this gap closed on AWS Emulator ${version}.`,
    "",
    `**The gap was:** ${outcome.gap}`,
    "",
    `**${next(outcome)}:** ${outcome.then}`,
    "",
    `**Where:** ${outcome.where.map((path) => `\`${path}\``).join(", ")}`,
    "",
    "## Done when",
    "",
  ];
  if (outcome.kind === "blocked") lines.push(`- [ ] #${outcome.issue} says this no longer blocks it`);
  if (outcome.kind === "workaround") lines.push("- [ ] The workaround is gone and `task ci` is green on `example/implementation`");
  if (outcome.kind === "limit") lines.push("- [ ] `docs/testing.md` no longer says the local tests cannot show this");
  lines.push(`- [ ] The gap \`${outcome.id}\` is removed from \`tools/emulator/gaps/\``);
  return { title: `Emulator gap closed: ${outcome.id}`, body: lines.join("\n") };
}
