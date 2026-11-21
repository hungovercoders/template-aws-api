#!/usr/bin/env node
// Bring up the local stack and either keep it running or run a command against it:
//   1. AWS Emulator
//   2. infra/ applied to it with Terraform - the same definitions that deploy to AWS
//   3. nothing else: the API is the emulator's HTTP API, routing to the Lambda
//      that apply created from the built bundle (dist/handler.mjs)
//   node local/stack.mjs                      keep running (task dev)
//   node local/stack.mjs -- npx cucumber-js   run the command with BASE_URL set, then stop
//
// AWS Emulator is found, in order:
//   1. AWS_ENDPOINT_URL already set  - use that endpoint and the ambient AWS settings as they are
//   2. one already serving on EMULATOR_PORT (e.g. the Docker container from `task emulator:docker`)
//   3. start a fresh one for this run, and stop it at the end:
//      - on Linux: AWS_EMULATOR_BIN, then .tools/ (from `task emulator:install`), then PATH
//      - on macOS and Windows, or with EMULATOR_DOCKER=1: a container of the image
//        `task emulator:install` builds, aws-emulator:<EMULATOR_VERSION>
// AWS Emulator cannot be reset, so a stack is applied to an emulator once:
// a second run against one that already has it says so instead of failing.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const command = sep === -1 ? [] : args.slice(sep + 1);
const children = [];
// Run when the stack stops: the container of a Docker emulator goes with it.
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Written while `task dev` is up, for `task http`.
const stackFile = join(".local", "stack.json");
// The callers the local stack accepts; local/token.ts signs tokens to match.
const jwt = { issuer: "https://issuer.invalid/", audience: "local" };

function stop(code) {
  rmSync(stackFile, { force: true });
  for (const child of children) child.kill("SIGTERM");
  for (const cleanup of cleanups) cleanup();
  process.exit(code);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));

function healthy(port, ca) {
  return new Promise((resolve) => {
    if (!existsSync(ca)) return resolve(false);
    const req = request({ host: "127.0.0.1", port, path: "/__admin/health", ca: readFileSync(ca), timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function emulatorEnv() {
  if (process.env.AWS_ENDPOINT_URL) {
    console.log(`using the AWS endpoint already configured: ${process.env.AWS_ENDPOINT_URL}`);
    return {};
  }
  const port = Number(process.env.EMULATOR_PORT ?? 9297);
  const dir = join(homedir(), ".aws", "emulator", String(port));
  const ca = join(dir, "ca.pem");

  if (await healthy(port, ca)) {
    console.log(`using the AWS Emulator already serving on port ${port}`);
  } else {
    const log = openSync(join(".local", "emulator.log"), "w");
    // AWS's own guidance: no usage telemetry from CI jobs. Anywhere else it is
    // the emulator's default (on) unless EMULATOR_TELEMETRY=off is set.
    const telemetry = process.env.CI ? ["-t", "off"] : [];
    // AWS ships a native package for Linux only; elsewhere the emulator runs in Docker.
    const docker = process.env.EMULATOR_DOCKER === "1" || (process.platform !== "linux" && !process.env.AWS_EMULATOR_BIN);
    let bin, args, hint;
    if (docker) {
      const name = `aws-emulator-${port}`;
      const shared = join(homedir(), ".aws", "emulator");
      mkdirSync(shared, { recursive: true });
      // A container left by a run that was killed would hold the port.
      spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      cleanups.push(() => spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
      bin = "docker";
      // The emulator writes its credentials and certificate under HOME, so the
      // container shares that folder with the host at the same path.
      args = ["run", "--rm", "--name", name, "--memory=2g", "--memory-swap=2g", "-p", `127.0.0.1:${port}:${port}`,
        "-e", `HOME=${homedir()}`, "-e", "EMULATOR_TELEMETRY", "-v", `${shared}:${shared}`,
        `aws-emulator:${process.env.EMULATOR_VERSION}`, "-p", String(port), ...telemetry];
      hint = "Is Docker running? Start Docker Desktop, then `task emulator:install` builds the emulator's image.";
    } else {
      const local = join(".tools", "aws-emulator", "opt", "aws-emulator", "bin", "aws-emulator");
      bin = process.env.AWS_EMULATOR_BIN ?? (existsSync(local) ? local : "aws-emulator");
      args = ["-p", String(port), ...telemetry];
      hint = "Run `task emulator:install`.";
    }
    const emulator = spawn(bin, args, { stdio: ["ignore", log, log] });
    children.push(emulator);
    let failed = null;
    emulator.on("error", (error) => (failed = `could not start AWS Emulator (${bin}): ${error.message}. ${hint}`));
    emulator.on("exit", (code) => (failed ??= `AWS Emulator exited with code ${code}; see .local/emulator.log. ${hint}`));
    // A container takes longer to start than the native package.
    const seconds = docker ? 90 : 30;
    for (let i = 0; i < seconds * 2 && !failed && !(await healthy(port, ca)); i++) await sleep(500);
    if (failed || !(await healthy(port, ca))) {
      console.error(failed ?? `AWS Emulator did not become healthy within ${seconds}s; see .local/emulator.log`);
      stop(1);
    }
    console.log(`AWS Emulator ready on https://127.0.0.1:${port}${docker ? " (in Docker)" : ""}`);
  }

  // From "Pointing your AWS SDK at AWS Emulator" in its user guide. The
  // emulator writes this run's credentials, SDK config and certificate to dir.
  return {
    AWS_ENDPOINT_URL: `https://127.0.0.1:${port}`,
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "emulator_credentials"),
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_CA_BUNDLE: ca,
    NODE_EXTRA_CA_CERTS: ca,
    REQUESTS_CA_BUNDLE: ca,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
  };
}

// Apply infra/ to the emulator. Its state lives in .local/ and is discarded
// each run, because the emulator starts empty each run.
let stackOutputs = {};
function deploy(env) {
  const state = resolve(".local", "emulator.tfstate");
  // Each emulator writes a certificate of its own when it starts, so its hash
  // says which emulator a stack was applied to. One that has the stack already
  // - `task dev` still up, or one you started and ran against before - cannot
  // be reset: say so, rather than fail on everything that already exists.
  const applied = resolve(".local", "emulator.applied");
  const emulator = env.AWS_CA_BUNDLE && existsSync(env.AWS_CA_BUNDLE) ? createHash("sha256").update(readFileSync(env.AWS_CA_BUNDLE)).digest("hex") : null;
  if (emulator && existsSync(applied) && readFileSync(applied, "utf8").trim() === emulator) {
    const port = new URL(env.AWS_ENDPOINT_URL).port;
    console.error(
      [
        `The AWS Emulator on port ${port} already has this stack, from \`task dev\` still running or an earlier run,`,
        "and an emulator cannot be reset. Stop it (Ctrl-C where it runs) and run this again - each run starts",
        `a fresh one - or give this run a port of its own: EMULATOR_PORT=${Number(port) + 1} task <task>`,
      ].join("\n"),
    );
    stop(1);
  }
  for (const file of [state, `${state}.backup`]) rmSync(file, { force: true });
  // init and apply print straight to the console, so a CI log shows what was
  // created; only `output` is captured.
  const terraform = (args, capture = false) => {
    const result = spawnSync("terraform", ["-chdir=infra", ...args], {
      env,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
      encoding: "utf8",
    });
    if (result.error || result.status !== 0) {
      console.error(result.error ? `could not run terraform: ${result.error.message}` : `terraform ${args[0]} failed against AWS Emulator`);
      stop(1);
    }
    return result.stdout;
  };
  if (!existsSync(join("infra", ".terraform", "providers"))) terraform(["init", "-input=false", "-no-color"]);
  const region = env.AWS_REGION ?? "us-east-1";
  // The emulated authorizer checks a token's issuer and audience against
  // these; it does not fetch the issuer's keys, so the issuer need not exist.
  const authorizer = ["-var", `jwt_issuer=${jwt.issuer}`, "-var", `jwt_audience=${jwt.audience}`];
  // Before the apply: one that fails half way has still left resources there.
  if (emulator) writeFileSync(applied, emulator + "\n");
  console.log("applying infra/ to AWS Emulator");
  terraform(["apply", "-auto-approve", "-input=false", "-no-color", "-lock=false", `-state=${state}`, "-var", "name=api-local", "-var", `region=${region}`, ...authorizer]);
  const outputs = JSON.parse(terraform(["output", "-json", `-state=${state}`], true));
  console.log("infra/ applied to AWS Emulator");
  // Every output is there for whatever runs against the stack, under its own
  // name in capitals (queue_url is QUEUE_URL), and kept for the tasks that
  // talk to a stack `task dev` has up.
  stackOutputs = Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, String(output.value)]));
  return {
    ...Object.fromEntries(Object.entries(stackOutputs).map(([name, value]) => [name.toUpperCase(), value])),
    TABLE_NAME: outputs.table_name.value,
    BASE_URL: outputs.base_url.value.replace(/\/$/, ""),
    LOCAL_JWT_ISSUER: jwt.issuer,
    LOCAL_JWT_AUDIENCE: jwt.audience,
  };
}

// When the command failed, what the Lambda logged is the first thing to read.
// Best effort: it needs the AWS CLI, and the emulator to have kept the logs.
function lambdaLogs(env, group = "/aws/lambda/api-local") {
  // The API's function, then any other the stack has (a queue consumer, the forwarder).
  if (group === "/aws/lambda/api-local") for (const other of ["consumer", "forwarder"]) lambdaLogs(env, `/aws/lambda/api-local-${other}`);
  const logs = spawnSync("aws", ["logs", "tail", group, "--since", "15m", "--format", "short"], { env, encoding: "utf8" });
  const lines = logs.status === 0 ? logs.stdout.trim().split("\n").filter(Boolean) : [];
  if (lines.length === 0) return;
  // Errors first: in a long run they are far above the end of the log.
  const errors = lines.filter((line) => /"level":"error"|errorType|\bERROR\b/.test(line));
  if (errors.length > 0) console.error(["", `--- the Lambda logged ${errors.length} errors; the last 10 ---`, ...errors.slice(-10).map((line) => line.slice(0, 2000))].join("\n"));
  console.error(["", "--- the end of the Lambda's log ---", ...lines.slice(-30)].join("\n"));
}

mkdirSync(".local", { recursive: true });
if (!existsSync(join("dist", "handler.mjs"))) {
  console.error("dist/handler.mjs is missing - run `task build` first (the tasks that use the stack do)");
  process.exit(1);
}
const overrides = await emulatorEnv();
// Locally a scenario should not wait as long as production would make a
// message wait: a failing message is offered again, and given up on, in
// seconds. Terraform ignores a TF_VAR_ for a variable the stack does not have.
// Firehose writes each event as it arrives, so a test of the data does not wait for a buffer.
const quick = { TF_VAR_consume_timeout: "5", TF_VAR_consume_visibility_timeout: "5", TF_VAR_consume_max_receives: "2", TF_VAR_data_buffer_seconds: "0" };
// The `repo` tag, from the git remote (scripts/tags.ts) - or this folder, where there is no remote to read.
const remote = spawnSync(process.execPath, ["--import", "tsx", "scripts/tags.ts", "repo"], { encoding: "utf8" });
const tags = { TF_VAR_repo: (remote.status === 0 && remote.stdout.trim()) || "https://localhost/local" };
const env = { ...quick, ...tags, ...process.env, ...overrides };
if (overrides.AWS_ENDPOINT_URL) {
  // Real credentials must never sign requests while the emulator is the target.
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
}

Object.assign(env, deploy(env));

// The API is the emulator's own HTTP API, routing to the Lambda that apply
// created from dist/handler.mjs. Nothing stands in for API Gateway.
const baseUrl = env.BASE_URL;
console.log(`API ready on ${baseUrl}`);

if (command.length > 0) {
  const run = spawn(command[0], command.slice(1), { stdio: "inherit", env });
  run.on("error", (error) => {
    console.error(`could not run ${command[0]}: ${error.message}`);
    stop(1);
  });
  run.on("exit", (code, signal) => {
    const status = code ?? (signal ? 1 : 0);
    if (status !== 0) lambdaLogs(env);
    stop(status);
  });
} else {
  // task dev: stay up, and tell `task http` (and you) how to call the API.
  const token = spawnSync(process.execPath, ["--import", "tsx", "local/token.ts", "explorer"], { env, encoding: "utf8" }).stdout.trim();
  writeFileSync(stackFile, JSON.stringify({ base_url: baseUrl, token, ca: env.AWS_CA_BUNDLE ?? "", env: overrides, outputs: stackOutputs }, null, 2) + "\n");
  console.log(
    [
      "",
      "The stack stays up until you stop it (Ctrl-C). In another terminal:",
      "  task http                       send the requests in http/contract.http to it",
      `  curl --cacert ${env.AWS_CA_BUNDLE ?? "<the emulator's ca.pem>"} ${baseUrl}/<path>`,
      "  a signed-in caller:             -H \"Authorization: Bearer $(node local/token.ts <name>)\"",
    ].join("\n"),
  );
}
