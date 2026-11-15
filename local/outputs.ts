// The outputs of the stack a command-line task talks to: the one `task dev`
// keeps up on AWS Emulator (ENV=local, the default), or the deployed one
// (ENV=aws, with your AWS credentials). For the local stack this also points
// the AWS SDK at the emulator, and never lets a request meant for it go to AWS.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function stackOutputs(task: string): Record<string, string | undefined> {
  const fail = (message: string): never => {
    console.error(`${task}: ${message}`);
    process.exit(1);
  };
  if ((process.env.ENV ?? "local") === "aws") {
    const run = spawnSync("terraform", ["-chdir=infra", "output", "-json"], { encoding: "utf8" });
    if (run.status !== 0) fail(`could not read the deployed stack's outputs\n${run.stderr.trim()}`);
    return Object.fromEntries(Object.entries(JSON.parse(run.stdout) as Record<string, { value: unknown }>).map(([name, output]) => [name, String(output.value)]));
  }
  if (!existsSync(".local/stack.json")) fail("the local stack is not up. Run `task dev` in another terminal, or use ENV=aws for the deployed stack.");
  const stack = JSON.parse(readFileSync(".local/stack.json", "utf8")) as { env?: Record<string, string>; outputs?: Record<string, string> };
  const emulator = stack.env ?? {};
  if (!emulator.AWS_ENDPOINT_URL && !process.env.AWS_ENDPOINT_URL) {
    fail("`task dev` was started against an emulator of your own (AWS_ENDPOINT_URL). Set the same AWS_ENDPOINT_URL here, with its credentials and certificate.");
  }
  // Its endpoint, credentials and certificate. Node reads the certificate when
  // it starts, so this starts again with the stack's settings in place.
  if (emulator.AWS_ENDPOINT_URL && process.env.NODE_EXTRA_CA_CERTS !== emulator.NODE_EXTRA_CA_CERTS) {
    const env = { ...process.env, ...emulator };
    // Real credentials must never sign requests while the emulator is the target.
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
    const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env });
    process.exit(again.status ?? 1);
  }
  return stack.outputs ?? {};
}
