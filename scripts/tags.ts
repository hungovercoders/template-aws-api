// The tags every resource carries (infra/tags.tf).
//   node scripts/tags.ts repo    - the repository's URL, from its git remote: the `repo` tag. Never typed
//   node scripts/tags.ts check   - gate: no resource that can carry tags is created without them
//   node scripts/tags.ts show    - the tags a stack would carry (NAME=<stack name>), and which are not yet set
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VALUES = "infra/tags.auto.tfvars.json";

class Problem extends Error {}
const stop = (message: string): never => {
  throw new Problem(message);
};

/** A git remote as the URL a person opens: no credentials, no .git, https for an ssh remote. */
export function repositoryUrl(remote: string): string | undefined {
  const given = remote.trim().replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(given);
  if (scp && !given.includes("://")) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(given);
    const scheme = url.protocol === "http:" ? "http" : "https";
    return `${scheme}://${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function repo(): string {
  // In GitHub Actions the repository is known without asking git.
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY) return `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`;
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const url = remote.status === 0 ? repositoryUrl(remote.stdout) : undefined;
  return url ?? stop("tags: this repository has no git remote named origin to read the `repo` tag from. Add one, or set TF_VAR_repo to the repository's URL.");
}

export function values(path = VALUES): { domain: string; team: string } {
  const given = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
  return { domain: String(given.domain ?? "").trim(), team: String(given.team ?? "").trim() };
}

// --- Gate ---------------------------------------------------------------------

type Block = { type: string; name: string; file: string; body: string };
/** Every `resource "<type>" "<name>" { ... }` in a directory's .tf files. */
export function resources(dir: string): Block[] {
  const found: Block[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".tf"))) {
    const text = readFileSync(join(dir, file), "utf8");
    for (const match of text.matchAll(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm)) {
      // To the brace that closes the block: the first one at the start of a line.
      const end = text.indexOf("\n}", match.index);
      found.push({ type: match[1]!, name: match[2]!, file: join(dir, file), body: text.slice(match.index, end < 0 ? undefined : end) });
    }
  }
  return found;
}

type Schemas = { provider_schemas?: Record<string, { resource_schemas?: Record<string, { block?: { attributes?: Record<string, unknown> } }> }> };

/** What is wrong with how a directory of Terraform tags what it creates. */
export function untagged(dir: string, schemas: Schemas): string[] {
  const problems: string[] = [];
  const text = readdirSync(dir)
    .filter((name) => name.endsWith(".tf"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
  // The AWS provider tags everything it creates, if it is told to.
  if (!/provider\s+"aws"\s*\{[^}]*default_tags\s*\{\s*tags\s*=\s*local\.tags\s*\}/s.test(text)) {
    problems.push(`${dir}: the aws provider has no \`default_tags { tags = local.tags }\`, so nothing it creates is tagged`);
  }
  const taggable = new Map<string, boolean>();
  for (const provider of Object.values(schemas.provider_schemas ?? {})) {
    for (const [type, schema] of Object.entries(provider.resource_schemas ?? {})) taggable.set(type, "tags" in (schema.block?.attributes ?? {}));
  }
  for (const resource of resources(dir)) {
    // Its own tags would replace the provider's on that key; only local.tags may be given by name.
    if (resource.type.startsWith("aws_")) continue;
    if (!taggable.has(resource.type)) problems.push(`${resource.file}: ${resource.type}.${resource.name} is of a provider whose schema could not be read, so whether it can carry tags is unknown`);
    else if (taggable.get(resource.type) && !/^\s*tags\s*=.*local\.tags/m.test(resource.body)) {
      problems.push(`${resource.file}: ${resource.type}.${resource.name} can carry tags but is not given local.tags - its provider has no default tags, so say \`tags = ...local.tags...\``);
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
    count += resources(dir).length;
  }
  if (problems.length > 0) stop(["tags:check failed", ...problems.map((problem) => `  - ${problem}`)].join("\n"));
  console.log(`tags:check ok - all ${count} resources in infra/ are tagged: by the aws provider's default tags, or by name`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [command] = process.argv.slice(2);
    if (command === "repo") console.log(repo());
    else if (command === "check") check();
    else if (command === "show") {
      const { domain, team } = values();
      const name = process.env.NAME || "<stack name>";
      for (const [key, value] of Object.entries({ domain, team, service: name, repo: repo() })) console.log(`${key.padEnd(8)} ${value || `(not set - say it in ${VALUES})`}`);
      if (!domain || !team) process.exit(1);
    } else stop("tags: repo | check | show");
  } catch (error) {
    if (!(error instanceof Problem)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
