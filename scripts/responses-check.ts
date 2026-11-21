// Gate: every response the contract documents is returned to a scenario.
// spec:check holds the features and the contract together per operation; this
// holds them together per response. A status the contract documents but no
// scenario ever receives is a promise nobody has explained or proved: either
// the behaviour spec is missing a scenario, or the contract says too much.
// Reads what the last full feature run was answered with (steps/world.ts
// records it), so it runs after `task features:run`, inside `task acceptance`.
// Not required: 5XX and default responses, which no scenario should be able
// to cause, and a 400 on an operation that takes no input. A 429 is API Gateway
// throttling a route at its major's x-rate-limit - the same setting on every route
// of that major, which infra/tests/http.tftest.hcl checks - so one scenario that
// calls one of a major's operations too fast proves it for all of them.
import { existsSync, readFileSync } from "node:fs";
import { operations } from "../src/lib/contract.ts";

const ANSWERED = ".local/responses-answered.json";
if (!existsSync(ANSWERED)) {
  console.error(`responses:check failed - ${ANSWERED} is missing; it is written by a full feature run (task acceptance)`);
  process.exit(1);
}
const answered = new Set(JSON.parse(readFileSync(ANSWERED, "utf8")) as string[]);

const unanswered = operations.flatMap((operation) => {
  const takesInput = operation.parameters.length > 0 || operation.requestBody !== undefined;
  return Object.keys(operation.responses)
    .filter((status) => /^[1-4]\d\d$/.test(status) && !(status === "400" && !takesInput))
    .filter((status) => !answered.has(`${operation.operationId} ${status}`))
    .filter((status) => !(status === "429" && operations.some((other) => other.version.split(".")[0] === operation.version.split(".")[0] && answered.has(`${other.operationId} 429`))))
    .map((status) => `${operation.operationId} ${status}`);
});

if (unanswered.length > 0) {
  console.error(
    [
      "responses:check failed - responses the contract documents that no scenario was answered with",
      ...unanswered.map((response) => `  - ${response}`),
      "  This is a gap in the spec, not the code. For each: add a scenario that shows when it",
      "  happens, or remove the response from the contract if it cannot.",
    ].join("\n"),
  );
  process.exit(1);
}
console.log(`responses:check ok - every documented response of ${operations.length} operations was returned to a scenario`);
