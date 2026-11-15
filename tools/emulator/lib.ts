// What a gap test is made of: the shape of a gap, and the few things most
// tests need - a role, a function, a queue, a Terraform apply. Every test
// runs against one emulator that `gaps.ts` started empty, and names what it
// creates after its own gap so tests never meet.
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { CreateFunctionCommand, LambdaClient, waitUntilFunctionActiveV2 } from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";

/**
 * workaround: the skeleton holds code that exists only because of the gap, and can go when it closes.
 * limit: nothing to remove - something the local tests cannot show, which the testing guide says.
 * blocked: a change to the template that waits for the gap to close; `issue` is that change.
 */
export type Kind = "workaround" | "limit" | "blocked";

export type Gap = {
  /** Also the name of what the test creates, and of its Terraform directory if it has one. */
  id: string;
  kind: Kind;
  /** What AWS Emulator does differently from AWS. */
  gap: string;
  /** What the template does because of it - so what to remove, change or unblock once it has closed. */
  then: string;
  /** The files that hold the workaround, or that say the limit. A gap none of whose files exist is not tested. */
  where: string[];
  /** The issue a blocked change waits in. */
  issue?: number;
  /** True while the gap is still there, false once it has closed. Throws when it cannot tell. */
  test: () => Promise<boolean>;
};

/** A stored (uncompressed) zip of one file: all a Lambda function needs, with no dependency. */
export function zip(name: string, text: string): Buffer {
  const data = Buffer.from(text);
  const file = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  central.writeUInt32LE((0o644 << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const iam = new IAMClient({});
const lambda = new LambdaClient({});
// Through the configured endpoint: the emulator's queue URLs name AWS itself (the gap `queue-url-host`).
export const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

/** A role any of the services a test uses may assume, allowed everything: the emulator checks that a policy is there, and these tests are not about IAM. */
export async function role(name: string): Promise<string> {
  const services = ["lambda.amazonaws.com", "events.amazonaws.com", "firehose.amazonaws.com"];
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: services }, Action: "sts:AssumeRole" }] };
  const made = await iam.send(new CreateRoleCommand({ RoleName: name, AssumeRolePolicyDocument: JSON.stringify(trust) }));
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] };
  await iam.send(new PutRolePolicyCommand({ RoleName: name, PolicyName: "all", PolicyDocument: JSON.stringify(policy) }));
  return made.Role!.Arn!;
}

/** A Node 22 function whose handler is `code`'s export `handler`. Returns its ARN once it can be invoked. */
export async function lambdaFunction(name: string, roleArn: string, code: string): Promise<string> {
  const made = await lambda.send(
    new CreateFunctionCommand({ FunctionName: name, Role: roleArn, Runtime: "nodejs22.x", Handler: "index.handler", Code: { ZipFile: zip("index.mjs", code) }, Timeout: 10 }),
  );
  await waitUntilFunctionActiveV2({ client: lambda, maxWaitTime: 30 }, { FunctionName: name });
  return made.FunctionArn!;
}

/** How many times a function has been started, from its log: the proof that something did invoke it. */
export async function invocations(name: string): Promise<number> {
  const logs = new CloudWatchLogsClient({});
  try {
    const found = await logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${name}`, filterPattern: '"START RequestId"' }));
    return (found.events ?? []).filter((event) => event.message?.startsWith("START RequestId")).length;
  } catch (error) {
    if ((error as Error).name === "ResourceNotFoundException") return 0;
    throw error;
  }
}

export async function queue(name: string, attributes: Record<string, string> = {}, tags?: Record<string, string>): Promise<{ url: string; arn: string }> {
  const made = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attributes, tags }));
  const read = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: made.QueueUrl, AttributeNames: ["QueueArn"] }));
  return { url: made.QueueUrl!, arn: read.Attributes!.QueueArn! };
}

/** The bodies that reach a queue within `seconds`, stopping early once there are `enough`. */
export async function received(url: string, seconds: number, enough = 1): Promise<string[]> {
  const bodies: string[] = [];
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until && bodies.length < enough) {
    const batch = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 120 }));
    bodies.push(...(batch.Messages ?? []).map((message) => message.Body ?? ""));
  }
  return bodies;
}

export type Applied = { ok: boolean; timedOut: boolean; output: string };

const WORK = resolve(".local", "emulator-gaps");
// Whatever is applying now, so a test that ran out of time does not go on working against the emulator the next one uses.
const applying = new Set<ChildProcess>();

/** Stop every Terraform a test left running. Terraform is asked first, so it takes its provider with it. */
export function stopTerraform(): void {
  for (const child of applying) {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
  }
}

// Providers come from the ones `terraform -chdir=infra init` already downloaded,
// at the versions infra/ is locked to. One that infra/ does not use (a removed
// component took it) is downloaded once, into a cache beside the copies.
function cliConfig(): string {
  const mirror = resolve("infra", ".terraform", "providers");
  const cache = join(WORK, "plugin-cache");
  mkdirSync(cache, { recursive: true });
  const path = join(WORK, "terraform.rc");
  const methods = existsSync(mirror) ? `  filesystem_mirror {\n    path = ${JSON.stringify(mirror)}\n  }\n  direct {}` : "  direct {}";
  writeFileSync(path, `plugin_cache_dir = ${JSON.stringify(cache)}\nprovider_installation {\n${methods}\n}\n`);
  return path;
}

function run(args: string[], cwd: string, seconds: number, env: NodeJS.ProcessEnv = {}): Promise<Applied> {
  return new Promise((done) => {
    const child = spawn("terraform", args, { cwd, env: { ...process.env, TF_IN_AUTOMATION: "1", TF_CLI_CONFIG_FILE: cliConfig(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    applying.add(child);
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, seconds * 1000);
    const finish = (ok: boolean, extra = "") => {
      clearTimeout(timer);
      applying.delete(child);
      done({ ok, timedOut, output: output + extra });
    };
    child.on("error", (error) => finish(false, `\n${error.message}`));
    child.on("exit", (code) => finish(code === 0 && !timedOut));
  });
}

/**
 * Apply `tools/emulator/terraform/<id>/` to the emulator, in a copy under
 * .local/ so nothing is left in the tree. `again` applies once more with those
 * variables; `debug` adds the provider's own log to the output, for a test
 * that has to see which call it made. A test reads `output` to tell its gap
 * from any other failure, and finds it afterwards in the copy's apply.log.
 */
export async function terraform(id: string, options: { seconds?: number; again?: string[]; debug?: boolean } = {}): Promise<Applied> {
  const dir = join(WORK, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(resolve("tools", "emulator", "terraform", id), dir, { recursive: true });
  const lock = resolve("infra", ".terraform.lock.hcl");
  if (existsSync(lock)) cpSync(lock, join(dir, ".terraform.lock.hcl"));
  const init = await run(["init", "-input=false", "-no-color"], dir, 300);
  if (!init.ok) throw new Error(`terraform init failed for ${id}\n${init.output.trim().slice(-1500)}`);
  const apply = ["apply", "-auto-approve", "-input=false", "-no-color"];
  const env = options.debug ? { TF_LOG: "DEBUG" } : {};
  let applied = await run(apply, dir, options.seconds ?? 90, env);
  if (applied.ok && options.again) applied = await run([...apply, ...options.again.map((variable) => `-var=${variable}`)], dir, options.seconds ?? 90, env);
  writeFileSync(join(dir, "apply.log"), applied.output);
  return applied;
}
