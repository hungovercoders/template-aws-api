// What a gap test is made of: the shape of a gap, and the few things most
// tests need - a role, a function, a queue, a Terraform apply. Every test
// runs against one emulator that `gaps.ts` started empty, and names what it
// creates after its own gap so tests never meet.
import { CreateFunctionCommand, LambdaClient, waitUntilFunctionActiveV2 } from "@aws-sdk/client-lambda";
import { CreateRoleCommand, IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Where the providers `terraform -chdir=infra init` downloaded are, so a test's own init fetches nothing. */
export const PROVIDERS = resolve("infra", ".terraform", "providers");
const WORK = resolve(".local", "emulator-gaps");

function run(args: string[], cwd: string, seconds: number): Promise<Applied> {
  return new Promise((done) => {
    const child = spawn("terraform", args, { cwd, env: { ...process.env, TF_IN_AUTOMATION: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, seconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, timedOut, output: `${output}\n${error.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, timedOut, output });
    });
  });
}

/**
 * Apply `tools/emulator/terraform/<id>/` to the emulator, in a copy under
 * .local/ so nothing is left in the tree. `again` applies once more with those
 * variables. A test reads `output` to tell its gap from any other failure.
 */
export async function terraform(id: string, options: { seconds?: number; again?: string[] } = {}): Promise<Applied> {
  const dir = join(WORK, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(resolve("tools", "emulator", "terraform", id), dir, { recursive: true });
  const init = await run(["init", "-input=false", "-no-color", `-plugin-dir=${PROVIDERS}`], dir, 120);
  if (!init.ok) throw new Error(`terraform init failed for ${id}\n${init.output.trim()}`);
  const apply = ["apply", "-auto-approve", "-input=false", "-no-color"];
  let applied = await run(apply, dir, options.seconds ?? 90);
  if (applied.ok && options.again) applied = await run([...apply, ...options.again.map((variable) => `-var=${variable}`)], dir, options.seconds ?? 90);
  // Kept beside the copy, for whoever wonders why a test said what it said.
  writeFileSync(join(dir, "apply.log"), applied.output);
  return applied;
}
