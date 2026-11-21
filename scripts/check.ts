// The fast gates for the stage this repository has reached - what the
// pre-push hook runs. `task ci` always runs every gate; this only decides
// which of the fast ones are worth running before a push.
//   node scripts/check.ts            run the gates of the current stage
//   node scripts/check.ts <stage>    move to <stage>, if its gates pass
// The stage is in .stage, and it is the skills that move it on: write-spec
// to "spec" when the spec is approved, implement-api to "implemented" when
// `task ci` is green. A repository with no .stage is checked in full.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gates as componentGates } from "./components-lib.ts";

const STAGES = {
  template: ["skeleton:check", "docs:check", "skills:check", "changelog:check", "example:check"],
  spec: ["spec:check", "spec:lint", "spec:compat", "slo:check", "http:check", "readme:check"],
  implemented: ["test:unit", "typecheck", "steps:check"],
} as const;
type Stage = keyof typeof STAGES;
const order = Object.keys(STAGES) as Stage[];
const isStage = (value: string): value is Stage => order.includes(value as Stage);

const recorded = existsSync(".stage") ? readFileSync(".stage", "utf8").trim() : "implemented";
const wanted = process.argv[2] ?? recorded;
if (!isStage(wanted)) {
  console.error(`check: "${wanted}" is not a stage (${order.join(", ")})`);
  process.exit(1);
}

// A component still in this repository adds its own fast gates to a stage.
const gates = order.slice(0, order.indexOf(wanted) + 1).flatMap((stage) => [...STAGES[stage], ...componentGates(stage)]);
for (const gate of gates) {
  const run = spawnSync("task", [gate], { stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`check: ${gate} failed${process.argv[2] ? ` - the stage stays "${recorded}"` : ""}`);
    process.exit(run.status ?? 1);
  }
}

const later = order.slice(order.indexOf(wanted) + 1);
if (process.argv[2]) {
  writeFileSync(".stage", `${wanted}\n`);
  console.log(`check: the stage is now "${wanted}" - commit .stage. The pre-push hook runs: ${gates.join(", ")}`);
} else {
  console.log(
    `check ok - stage "${wanted}", ${gates.length} gates` +
      (later.length > 0 ? `. Not yet run before a push: ${later.flatMap((stage) => STAGES[stage]).join(", ")} (task stage -- ${later[0]} turns the next ones on)` : ""),
  );
}
