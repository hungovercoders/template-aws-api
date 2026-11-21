// What a stack is made of: every AWS resource it created, by service - the local
// stack `task dev` keeps up (ENV=local, the default), or the deployed one (ENV=aws,
// with your AWS credentials). Read from the stack's Terraform state, so it is exactly
// what the stack manages, on the emulator as on AWS; a setting with no ARN of its own
// (a policy, a permission) is part of the resource it configures. On AWS the same
// resources, tagged with the service, are its resource group (infra/tags.tf).
//   node local/resources.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type State = { resources?: { mode?: string; instances?: { attributes?: Record<string, unknown> }[] }[] };

/** Every resource the state holds with an ARN of its own, each once. */
export function arnsOf(state: State): string[] {
  const arns = (state.resources ?? []).filter((resource) => resource.mode === "managed").flatMap((resource) => (resource.instances ?? []).map((instance) => instance.attributes?.arn));
  return [...new Set(arns.filter((arn): arn is string => typeof arn === "string" && arn.startsWith("arn:")))];
}

/** An ARN's service, and the resource as that service names it: arn:partition:service:region:account:resource. */
export function partsOf(arn: string): { service: string; resource: string } {
  const [, , service = "?", , , ...rest] = arn.split(":");
  return { service, resource: rest.join(":") };
}

/** The resources, a heading per AWS service, each sorted by name. */
export function render(arns: string[]): string {
  const byService = new Map<string, string[]>();
  for (const { service, resource } of arns.map(partsOf)) byService.set(service, [...(byService.get(service) ?? []), resource]);
  return [...byService.keys()]
    .sort()
    .flatMap((service) => [`${service} (${byService.get(service)!.length})`, ...byService.get(service)!.sort().map((resource) => `  ${resource}`)])
    .join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const fail = (message: string): never => {
    console.error(`resources: ${message}`);
    process.exit(1);
  };
  const aws = (process.env.ENV ?? "local") === "aws";
  let state: State;
  if (aws) {
    const pull = spawnSync("terraform", ["-chdir=infra", "state", "pull"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (pull.status !== 0) fail(`could not read the deployed stack's state\n${pull.stderr.trim()}`);
    if (!pull.stdout.trim()) fail("this checkout has no deployed stack's state: deploy it, or `terraform -chdir=infra init` with the backend it was deployed with");
    state = JSON.parse(pull.stdout) as State;
  } else {
    if (!existsSync(".local/stack.json") || !existsSync(".local/emulator.tfstate")) fail("the local stack is not up. Run `task dev` in another terminal, or use ENV=aws for the deployed stack.");
    state = JSON.parse(readFileSync(".local/emulator.tfstate", "utf8")) as State;
  }
  const arns = arnsOf(state);
  if (arns.length === 0) fail(aws ? "the deployed stack has no resources - has it been deployed?" : "the local stack has no resources yet");
  const group = arns.find((arn) => partsOf(arn).service === "resource-groups");
  const name = group ? partsOf(group).resource.replace(/^group\//, "") : "?";
  const region = group?.split(":")[3];
  console.log(`${name} - ${aws ? `deployed to ${region}` : "the local stack"}: ${arns.length} resources\n`);
  console.log(render(arns));
  if (aws && group) console.log(`\nIts resource group in the console: https://${region}.console.aws.amazon.com/resource-groups/group/${encodeURIComponent(name)}`);
}
