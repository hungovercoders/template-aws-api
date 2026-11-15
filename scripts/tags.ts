// The tags every resource carries (infra/tags.tf).
//   node scripts/tags.ts repo    - the repository's URL, from its git remote: the `repo` tag. Never typed
//   node scripts/tags.ts check   - gate: no resource that can carry tags is created without them
//   node scripts/tags.ts show    - the tags a stack would carry (NAME=<stack name>), and which are not yet set
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const VALUES = "infra/tags.auto.tfvars.json";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

/** A git remote as the URL a person opens: no credentials, no .git, https for an ssh remote. Undefined when it is not somewhere a person could open. */
export function repositoryUrl(remote: string): string | undefined {
  const given = remote.trim().replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(given);
  if (scp && !given.includes("://")) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(given);
    if (!url.hostname || !["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    // An ssh or git port is not where the web page is.
    const host = url.protocol === "http:" || url.protocol === "https:" ? url.host : url.hostname;
    return `${url.protocol === "http:" ? "http" : "https"}://${host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function repo(): string {
  // Said by hand, for a checkout with no remote to read.
  if (process.env.TF_VAR_repo) return process.env.TF_VAR_repo;
  // In GitHub Actions the repository is known without asking git.
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const url = remote.status === 0 ? repositoryUrl(remote.stdout) : undefined;
  return url ?? stop("tags: the `repo` tag is read from the git remote named origin, and this repository has none that is a URL. Add one, or set TF_VAR_repo to the repository's URL.");
}

/** The stage of its life a stack's name says it is, as infra/tags.tf reads it. */
export const environment = (name: string) => /-(dev|test|staging|prod)$/.exec(name)?.[1];

export function values(path = VALUES): { domain: string; team: string } {
  const given = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  return { domain: String(given.domain ?? "").trim(), team: String(given.team ?? "").trim() };
}

// --- Gate ---------------------------------------------------------------------

const OWN = ["domain", "team", "service", "repo", "environment"];
// Types the aws provider does not add its default tags to.
const NO_DEFAULT_TAGS = ["aws_autoscaling_group"];

/** Terraform without its comments, so nothing in one is read as code. Strings are kept. */
function code(text: string): string {
  return text.replace(/"(?:\\.|[^"\\\n])*"|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : ""));
}

/** From an opening bracket to the one that closes it, strings aside. */
function balanced(text: string, open: number): string {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let at = open; at < text.length; at++) {
    const char = text[at]!;
    if (char === '"') {
      // To the end of the string; an interpolation inside it is part of it.
      for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === "\\") at++;
    } else if (pairs[char]) stack.push(pairs[char]!);
    else if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return text.slice(open, at + 1);
    }
  }
  return text.slice(open);
}

type Block = { kind: string; type: string; name: string; file: string; body: string };
const tfFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // A directory of its own root (bootstrap) or of Terraform's (.terraform) is not this stack's.
    if (entry.isDirectory()) return entry.name.startsWith(".") || entry.name === "bootstrap" ? [] : tfFiles(join(dir, entry.name));
    return entry.name.endsWith(".tf") ? [join(dir, entry.name)] : [];
  });

/** Every provider, resource and module block under a directory. */
export function blocks(dir: string): Block[] {
  const found: Block[] = [];
  for (const file of tfFiles(dir)) {
    const text = code(readFileSync(file, "utf8"));
    for (const match of text.matchAll(/^(provider|resource|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm)) {
      found.push({ kind: match[1]!, type: match[2]!, name: match[3] ?? "", file, body: balanced(text, match.index + match[0].length - 1) });
    }
  }
  return found;
}

/** What a block's own `tags` argument is set to, or undefined when it has none. */
function tagsOf(body: string): string | undefined {
  // Its own argument: one level in, not inside a nested block.
  let depth = 0;
  for (let at = 0; at < body.length; at++) {
    const char = body[at]!;
    if (char === '"') {
      for (at++; at < body.length && body[at] !== '"'; at++) if (body[at] === "\\") at++;
    } else if ("{([".includes(char)) depth++;
    else if ("})]".includes(char)) depth--;
    else if (depth === 1 && body[at - 1] === "\n") {
      const match = /^[ \t]*tags[ \t]*=[ \t]*/.exec(body.slice(at));
      if (!match) continue;
      const start = at + match[0].length;
      const first = body.slice(start).search(/[{([]|\n/);
      // Up to the end of the line, or of the bracket it opens.
      return first >= 0 && body[start + first] !== "\n" ? body.slice(start, start + first) + balanced(body, start + first) : body.slice(start, start + Math.max(first, 0));
    }
  }
  return undefined;
}

type Schemas = { provider_schemas?: Record<string, { resource_schemas?: Record<string, { block?: { attributes?: Record<string, unknown> } }> }> };

/** What is wrong with how a directory of Terraform tags what it creates. */
export function untagged(dir: string, schemas: Schemas): string[] {
  const problems: string[] = [];
  const all = blocks(dir);
  // The AWS provider tags everything it creates, if it is told to - every one of them, an aliased one too.
  const providers = all.filter((block) => block.kind === "provider" && block.type === "aws");
  if (providers.length === 0) problems.push(`${dir}: there is no aws provider to give the default tags`);
  for (const provider of providers) {
    const defaults = /\bdefault_tags\s*\{/.exec(provider.body);
    const given = defaults ? tagsOf(balanced(provider.body, defaults.index + defaults[0].length - 1)) : undefined;
    if (!given || !/^local\.tags\s*$/.test(given.trim())) problems.push(`${provider.file}: an aws provider has no \`default_tags { tags = local.tags }\`, so nothing it creates is tagged`);
  }
  for (const module of all.filter((block) => block.kind === "module")) {
    problems.push(`${module.file}: module "${module.type}" is not read by this gate; make sure what it creates is tagged, and list it in scripts/tags.ts when it is`);
  }
  const taggable = new Map<string, boolean>();
  for (const provider of Object.values(schemas.provider_schemas ?? {})) {
    for (const [type, schema] of Object.entries(provider.resource_schemas ?? {})) taggable.set(type, "tags" in (schema.block?.attributes ?? {}));
  }
  for (const resource of all.filter((block) => block.kind === "resource")) {
    const at = `${resource.file}: ${resource.type}.${resource.name}`;
    const own = tagsOf(resource.body);
    if (NO_DEFAULT_TAGS.includes(resource.type)) {
      if (!/\blocal\.tags\b/.test(resource.body)) problems.push(`${at} does not take the provider's default tags; give it local.tags itself`);
    } else if (resource.type.startsWith("aws_")) {
      // It has the provider's. Tags of its own may add to them, never replace one.
      const replaced = OWN.filter((key) => own && new RegExp(`(^|[{,\\s"])${key}"?\\s*=`).test(own));
      if (replaced.length > 0) problems.push(`${at} sets ${replaced.join(", ")} itself, which replaces the stack's on that resource; leave ${replaced.length > 1 ? "them" : "it"} to the provider's default tags`);
    } else if (!taggable.has(resource.type)) {
      problems.push(`${at} is of a provider whose schema could not be read, so whether it can carry tags is unknown`);
    } else if (taggable.get(resource.type) && !(own && /\blocal\.tags\b/.test(own))) {
      problems.push(`${at} can carry tags but is not given local.tags - its provider has no default tags, so say \`tags = ...local.tags...\``);
    }
  }
  return problems;
}

function check(): void {
  const problems: string[] = [];
  let count = 0;
  for (const dir of ["infra", "infra/bootstrap"]) {
    // Needs the providers: `task infra:validate` has run init.
    const run = spawnSync("terraform", [`-chdir=${dir}`, "providers", "schema", "-json"], { encoding: "utf8", maxBuffer: 1 << 30 });
    if (run.status !== 0) stop(`tags:check failed - could not read the providers' schemas in ${dir}\n${(run.stderr ?? "").trim() || run.error?.message}`);
    problems.push(...untagged(dir, JSON.parse(run.stdout) as Schemas));
    count += blocks(dir).filter((block) => block.kind === "resource").length;
  }
  if (problems.length > 0) stop(["tags:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  console.log(`tags:check ok - all ${count} resources in infra/ are tagged: by the aws provider's default tags, or by name`);
}

// Run as a script, wherever the checkout is and however it was reached - not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [command] = process.argv.slice(2);
    if (command === "repo") console.log(repo());
    else if (command === "check") check();
    else if (command === "show") {
      const { domain, team } = values();
      const name = process.env.NAME || "";
      const tags = { domain, team, service: name || "<the stack's name: NAME=...>", repo: repo(), ...(environment(name) ? { environment: environment(name)! } : {}) };
      for (const [key, value] of Object.entries(tags)) console.log(`${key.padEnd(12)}${value || `(not set - say it in ${VALUES})`}`);
      if (!domain || !team) process.exit(1);
    } else stop("tags: repo | check | show");
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
