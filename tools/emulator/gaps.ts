// `task emulator:gaps`: what AWS Emulator still cannot do that this
// repository works around, lives with, or waits for. The gaps are the files in
// tools/emulator/gaps/, each entry with its test. This starts the pinned
// emulator empty, on a port of its own, runs every test against it and says
// for each "still needed" or "the gap has closed".
//   node tools/emulator/gaps.ts                 test every gap
//   node tools/emulator/gaps.ts <id> [<id>...]  test those
//   node tools/emulator/gaps.ts --list          list them, without an emulator
//   node tools/emulator/gaps.ts --issues        open an issue for each gap the last run found closed (CI; needs gh)
// A closed gap is not a failure: it exits 0. It exits 1 only when a test could
// not tell, so that a broken test is seen.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Gap } from "./lib.ts";
import { applies, issue, type Listed, type Outcome, report, summary } from "./report.ts";

const RESULTS = join(".local", "emulator-gaps.json");
const TEST_SECONDS = 180;

const fail = (message: string): never => {
  console.error(`emulator:gaps: ${message}`);
  process.exit(1);
};

async function listed(): Promise<Gap[]> {
  const dir = join("tools", "emulator", "gaps");
  const all: Gap[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) {
    const module = (await import(new URL(`./gaps/${file}`, import.meta.url).href)) as { gaps: Gap[] };
    all.push(...module.gaps);
  }
  const ids = all.map((gap) => gap.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) fail(`two gaps are called ${twice}`);
  return all.filter((gap) => applies(gap, existsSync));
}

function healthy(port: number, ca: string): Promise<boolean> {
  return new Promise((done) => {
    if (!existsSync(ca)) return done(false);
    const call = request({ host: "127.0.0.1", port, path: "/__admin/health", ca: readFileSync(ca), timeout: 2000 }, (response) => {
      response.resume();
      done(response.statusCode === 200);
    });
    call.on("error", () => done(false));
    call.on("timeout", () => call.destroy());
    call.end();
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The parent: start an empty emulator, run the tests in a child that trusts its certificate, stop it.
async function withEmulator(args: string[]): Promise<never> {
  const local = join(".tools", "aws-emulator", "opt", "aws-emulator", "bin", "aws-emulator");
  const bin = process.env.AWS_EMULATOR_BIN ?? (existsSync(local) ? local : "aws-emulator");
  const version = /Version: (\S+)/.exec(spawnSync(bin, ["-v"], { encoding: "utf8" }).stdout ?? "")?.[1] ?? fail(`could not run AWS Emulator (${bin}). Run \`task emulator:install\`.`);
  const port = Number(process.env.EMULATOR_GAPS_PORT ?? 9298);
  const dir = join(homedir(), ".aws", "emulator", String(port));
  const ca = join(dir, "ca.pem");
  // The tests assume nothing exists yet, so an emulator already there is never used.
  if (await healthy(port, ca)) fail(`something is already serving on port ${port}. Stop it, or set EMULATOR_GAPS_PORT.`);

  // The providers every Terraform test uses are the ones infra/ already has.
  const init = spawnSync("terraform", ["-chdir=infra", "init", "-backend=false", "-input=false"], { encoding: "utf8" });
  if (init.status !== 0) fail(`terraform init failed for infra/\n${init.stderr}`);

  mkdirSync(".local", { recursive: true });
  const log = openSync(join(".local", "emulator-gaps.log"), "w");
  const emulator = spawn(bin, ["-p", String(port), "-t", "off"], { stdio: ["ignore", log, log] });
  const stop = (code: number): never => {
    emulator.kill();
    process.exit(code);
  };
  process.on("SIGINT", () => stop(130));
  process.on("SIGTERM", () => stop(143));
  for (let tries = 0; tries < 60 && !(await healthy(port, ca)); tries++) await sleep(500);
  if (!(await healthy(port, ca))) {
    console.error("emulator:gaps: AWS Emulator did not become healthy within 30s; see .local/emulator-gaps.log");
    stop(1);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AWS_ENDPOINT_URL: `https://127.0.0.1:${port}`,
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "emulator_credentials"),
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_CA_BUNDLE: ca,
    NODE_EXTRA_CA_CERTS: ca,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    EMULATOR_GAPS_VERSION: version,
  };
  // Real credentials must never sign requests while the emulator is the target.
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
  const child = spawn(process.execPath, [process.argv[1]!, "--run", ...args], { stdio: "inherit", env });
  return new Promise<never>(() => child.on("exit", (code) => stop(code ?? 1)));
}

// The child: every test, one after another, each with a limit.
async function run(only: string[]): Promise<void> {
  const version = process.env.EMULATOR_GAPS_VERSION ?? "unknown";
  const all = await listed();
  const unknown = only.filter((id) => !all.some((gap) => gap.id === id));
  if (unknown.length > 0) fail(`no gap called ${unknown.join(", ")}. \`task emulator:gaps -- --list\` lists them.`);
  const chosen = only.length > 0 ? all.filter((gap) => only.includes(gap.id)) : all;
  const outcomes: Outcome[] = [];
  for (const { test, ...gap } of chosen) {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer within ${TEST_SECONDS}s`)), TEST_SECONDS * 1000)));
    const outcome: Outcome = await Promise.race([test(), limit]).then(
      (open) => ({ ...gap, result: open ? ("still-needed" as const) : ("closed" as const), seconds: (Date.now() - started) / 1000 }),
      (error: Error) => ({ ...gap, result: "unknown" as const, detail: `${error.name}: ${error.message}`, seconds: (Date.now() - started) / 1000 }),
    );
    clearTimeout(timer);
    outcomes.push(outcome);
    console.log(`  ${outcome.id}: ${outcome.result}`);
  }
  writeFileSync(RESULTS, JSON.stringify({ version, outcomes }, null, 2) + "\n");
  console.log(`\n${report(outcomes, version)}`);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary(outcomes, version), { flag: "a" });
  process.exit(outcomes.some((outcome) => outcome.result === "unknown") ? 1 : 0);
}

// For CI: an issue for each closed gap, unless one is already open for it.
function issues(): void {
  if (!existsSync(RESULTS)) fail(`${RESULTS} is not there. Run \`task emulator:gaps\` first.`);
  const { version, outcomes } = JSON.parse(readFileSync(RESULTS, "utf8")) as { version: string; outcomes: Outcome[] };
  const gh = (args: string[]) => {
    const done = spawnSync("gh", args, { encoding: "utf8" });
    if (done.status !== 0) fail(`gh ${args[0]} ${args[1]} failed\n${done.stderr.trim()}`);
    return done.stdout;
  };
  for (const outcome of outcomes.filter((candidate) => candidate.result === "closed")) {
    const { title, body } = issue(outcome, version);
    const open = JSON.parse(gh(["issue", "list", "--state", "open", "--search", `"${title}" in:title`, "--json", "title"])) as { title: string }[];
    if (open.some((existing) => existing.title === title)) console.log(`already open: ${title}`);
    else console.log(`opened ${gh(["issue", "create", "--title", title, "--body", body]).trim()}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--list") {
  const all: Listed[] = await listed();
  for (const gap of all) console.log(`${gap.id}  (${gap.kind}${gap.issue ? `, #${gap.issue}` : ""})\n  gap:  ${gap.gap}\n  then: ${gap.then}\n  in:   ${gap.where.join(", ")}\n`);
  console.log(`${all.length} gaps. \`task emulator:gaps\` tests them against the pinned AWS Emulator.`);
} else if (args[0] === "--issues") issues();
else if (args[0] === "--run") await run(args.slice(1));
else await withEmulator(args);
