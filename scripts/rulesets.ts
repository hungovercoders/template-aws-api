// An API adds its own contract rules in a ruleset of its own, which must keep
// the house rules: extend them, and change none of what they inherit except to
// make a rule fail the lint where it did not.
//   node scripts/rulesets.ts <api ruleset> <house ruleset>   - gate, run by the lint tasks before Spectral
// The lint tasks then lint with the API's ruleset, so without this an API
// could switch the house rules off - drop the extends, set a rule to off -
// without changing anything skeleton.lock holds.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

type Extends = string | [string, string?];
export type Ruleset = { extends?: Extends | Extends[]; rules?: Record<string, unknown>; overrides?: unknown; except?: unknown };

/** The severities that fail a lint run with --fail-severity warn, as Spectral accepts them. */
const FAILS = new Set<unknown>(["error", "warn", 0, 1, true]);
/** Spectral's own rulesets, which a house ruleset may build on. */
const BUILT_IN = new Set(["spectral:oas", "spectral:asyncapi", "spectral:arazzo"]);

const read = (path: string): Ruleset => (parse(readFileSync(path, "utf8")) ?? {}) as Ruleset;
/** How a ruleset may extend another: wholly, its recommended rules, or switched off. */
const MODES = new Set(["all", "recommended", "off"]);

/** A ruleset's extends as [source, mode] pairs: one source, a [source, mode] pair, or a list of either. */
function entries(ruleset: Ruleset): [string, string | undefined][] {
  const given = ruleset.extends;
  if (given === undefined) return [];
  const pair = (entry: Extends): [string, string | undefined] => (Array.isArray(entry) ? [entry[0], entry[1]] : [entry, undefined]);
  if (!Array.isArray(given)) return [pair(given)];
  if (given.length === 2 && typeof given[0] === "string" && typeof given[1] === "string" && MODES.has(given[1])) return [[given[0], given[1]]];
  return (given as Extends[]).map(pair);
}

/** Every rule a ruleset holds, its own and those it extends: what an API ruleset that extends it inherits. */
export async function inherited(path: string): Promise<Set<string>> {
  const ruleset = read(path);
  const names = new Set(Object.keys(ruleset.rules ?? {}));
  for (const [source] of entries(ruleset)) {
    if (BUILT_IN.has(source)) {
      const builtIn = (await import("@stoplight/spectral-rulesets")) as unknown as Record<string, { rules: Record<string, unknown> }>;
      for (const name of Object.keys(builtIn[source.slice("spectral:".length)]!.rules)) names.add(name);
    } else if (!/^[a-z]+:/.test(source)) {
      for (const name of await inherited(resolve(dirname(path), source))) names.add(name);
    }
  }
  return names;
}

/** What is wrong with an API's ruleset, given the path of the house ruleset it must keep and every rule that house ruleset holds. */
export function problems(ruleset: Ruleset, at: string, house: string, houseRules: Set<string>): string[] {
  const found: string[] = [];
  const kept = entries(ruleset).some(([source, mode]) => !/^[a-z]+:/.test(source) && resolve(dirname(at), source) === resolve(house) && mode !== "off");
  if (!kept) found.push(`it does not extend ${house}: add "${house.startsWith(".") ? house : `./${house}`}" to its extends`);
  if (ruleset.overrides !== undefined) found.push("it has overrides, which can switch rules off for some files or paths");
  if (ruleset.except !== undefined) found.push("it has except, which exempts paths from rules");
  for (const [name, value] of Object.entries(ruleset.rules ?? {})) {
    if (!houseRules.has(name)) continue;
    const defines = typeof value === "object" && value !== null && ("then" in value || "given" in value);
    const severity = typeof value === "object" && value !== null ? (value as { severity?: unknown }).severity : value;
    if (defines) found.push(`it redefines ${name}, which the house rules hold; give a rule of its own a name of its own`);
    else if (!FAILS.has(severity)) found.push(`it sets ${name} to ${JSON.stringify(severity ?? value)}; a rule it inherits can only be made to fail the lint (error or warn)`);
  }
  return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [api, house] = process.argv.slice(2);
  if (!api || !house) {
    console.error("usage: node scripts/rulesets.ts <api ruleset> <house ruleset>");
    process.exit(2);
  }
  // With no ruleset of its own, the API is linted with the house rules themselves.
  if (resolve(api) !== resolve(house)) {
    if (!existsSync(api)) {
      console.error(`rulesets: ${api} is missing. It is this API's contract rules, and extends ${house}; restore it from the template.`);
      process.exit(1);
    }
    const found = problems(read(api), api, house, await inherited(house));
    if (found.length > 0) {
      console.error([`rulesets: ${api} would weaken the house rules in ${house}:`, ...found.map((problem) => `  - ${problem}`), "  A house rule changes in the template, once, for every API."].join("\n"));
      process.exit(1);
    }
  }
}
