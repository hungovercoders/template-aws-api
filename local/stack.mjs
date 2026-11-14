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
//   3. start one: AWS_EMULATOR_BIN, then .tools/ (from `task emulator:install`), then PATH
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const command = sep === -1 ? [] : args.slice(sep + 1);
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Written while `task dev` is up, for `task http`.
const stackFile = join(".local", "stack.json");
// The callers the local stack accepts; local/token.ts signs tokens to match.
const jwt = { issuer: "https://issuer.invalid/", audience: "local" };

function stop(code) {
  rmSync(stackFile, { force: true });
  for (const child of children) child.kill("SIGTERM");
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
    const local = join(".tools", "aws-emulator", "opt", "aws-emulator", "bin", "aws-emulator");
    const bin = process.env.AWS_EMULATOR_BIN ?? (existsSync(local) ? local : "aws-emulator");
    const log = openSync(join(".local", "emulator.log"), "w");
    const emulator = spawn(bin, ["-p", String(port)], { stdio: ["ignore", log, log] });
    children.push(emulator);
    let failed = null;
    emulator.on("error", (error) => (failed = `could not start AWS Emulator (${bin}): ${error.message}. Run \`task emulator:install\`.`));
    emulator.on("exit", (code) => (failed ??= `AWS Emulator exited with code ${code}; see .local/emulator.log`));
    for (let i = 0; i < 60 && !failed && !(await healthy(port, ca)); i++) await sleep(500);
    if (failed || !(await healthy(port, ca))) {
      console.error(failed ?? "AWS Emulator did not become healthy within 30s; see .local/emulator.log");
      stop(1);
    }
    console.log(`AWS Emulator ready on https://127.0.0.1:${port}`);
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
function deploy(env) {
  const state = resolve(".local", "emulator.tfstate");
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
  console.log("applying infra/ to AWS Emulator");
  terraform(["apply", "-auto-approve", "-input=false", "-no-color", "-lock=false", `-state=${state}`, "-var", "name=api-local", "-var", `region=${region}`, ...authorizer]);
  const outputs = JSON.parse(terraform(["output", "-json", `-state=${state}`], true));
  console.log("infra/ applied to AWS Emulator");
  return { TABLE_NAME: outputs.table_name.value, BASE_URL: outputs.base_url.value.replace(/\/$/, ""), LOCAL_JWT_ISSUER: jwt.issuer, LOCAL_JWT_AUDIENCE: jwt.audience };
}

// When the command failed, what the Lambda logged is the first thing to read.
// Best effort: it needs the AWS CLI, and the emulator to have kept the logs.
function lambdaLogs(env) {
  const logs = spawnSync("aws", ["logs", "tail", "/aws/lambda/api-local", "--since", "15m", "--format", "short"], { env, encoding: "utf8" });
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
const env = { ...process.env, ...overrides };
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
  writeFileSync(stackFile, JSON.stringify({ base_url: baseUrl, token, ca: env.AWS_CA_BUNDLE ?? "" }, null, 2) + "\n");
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
