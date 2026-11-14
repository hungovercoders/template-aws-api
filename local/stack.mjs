#!/usr/bin/env node
// Bring up the local stack - AWS Emulator, then the Lambda behind a local
// API Gateway stand-in - and either keep it running or run a command against it.
//   node local/stack.mjs                      keep running (task dev)
//   node local/stack.mjs -- npx cucumber-js   run the command with BASE_URL set, then stop
//
// AWS Emulator is found, in order:
//   1. AWS_ENDPOINT_URL already set  - use that endpoint and the ambient AWS settings as they are
//   2. one already serving on EMULATOR_PORT (e.g. the Docker container from `task emulator:docker`)
//   3. start one: AWS_EMULATOR_BIN, then .tools/ (from `task emulator:install`), then PATH
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const command = sep === -1 ? [] : args.slice(sep + 1);
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stop(code) {
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
    mkdirSync(".local", { recursive: true });
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
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
  };
}

const overrides = await emulatorEnv();
const env = { ...process.env, ...overrides };
if (overrides.AWS_ENDPOINT_URL) {
  // Real credentials must never sign requests while the emulator is the target.
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
}

// The Lambda, behind the local API Gateway stand-in. With a command to run it
// takes a free port; on its own it serves on PORT (default 3000).
const api = spawn(process.execPath, ["--import", "tsx", "local/server.ts"], {
  env: { ...env, PORT: process.env.PORT ?? (command.length > 0 ? "0" : "3000") },
  stdio: ["ignore", "pipe", "inherit"],
});
children.push(api);
const baseUrl = await new Promise((resolve) => {
  let output = "";
  api.stdout.on("data", (chunk) => {
    output += chunk;
    const url = /listening (http:\/\/\S+)/.exec(output)?.[1];
    if (url) resolve(url);
  });
  api.on("exit", (code) => {
    console.error(`the local API exited with code ${code} before it was ready`);
    stop(1);
  });
});
api.stdout.on("data", (chunk) => process.stdout.write(chunk));
console.log(`API ready on ${baseUrl}`);

if (command.length > 0) {
  const run = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...env, BASE_URL: baseUrl } });
  run.on("error", (error) => {
    console.error(`could not run ${command[0]}: ${error.message}`);
    stop(1);
  });
  run.on("exit", (code, signal) => stop(code ?? (signal ? 1 : 0)));
}
