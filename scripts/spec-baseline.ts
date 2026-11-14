// The last published spec: what a change to a contract is compared with.
// On a branch it is where the branch left the default branch; on the default
// branch, the commit before. Override with SPEC_BASELINE=<git ref>.
import { spawnSync } from "node:child_process";

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

export function baseline(): string | undefined {
  if (process.env.SPEC_BASELINE) return process.env.SPEC_BASELINE;
  const head = git("rev-parse", "HEAD");
  const trunk = ["origin/HEAD", "origin/main", "origin/master"].find((ref) => git("rev-parse", "--verify", "--quiet", ref));
  const fork = trunk && git("merge-base", "HEAD", trunk);
  if (fork && fork !== head) return fork;
  return git("rev-parse", "--verify", "--quiet", "HEAD~1");
}

// A file as it was at a ref, or undefined when it was not there.
export const show = (ref: string, path: string) => git("show", `${ref}:${path}`);
