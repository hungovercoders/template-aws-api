// What follows from the `receive` operations of the AsyncAPI contract, for
// the queue consumer (src/lib/consumer.ts):
//   node scripts/consume.ts generate   - src/generated/consumers.ts: every receive operation wired to
//                                        the function of that name in src/consumers/<operation>.ts
//   node scripts/consume.ts scaffold   - a typed stub for each receive operation that has no file yet
//   node scripts/consume.ts check      - gate: every receive operation was delivered to a scenario
//                                        in the last full feature run
// It reads what `task generate` wrote from the contract, so it needs no
// AsyncAPI tooling of its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { operations, payloadType } from "../tools/asyncapi/operations.ts";

const receives = () => operations("receive");
const file = (id: string) => `src/consumers/${id}.ts`;

function generate(): void {
  const ids = receives().map((operation) => operation.id);
  mkdirSync("src/generated", { recursive: true });
  writeFileSync(
    "src/generated/consumers.ts",
    [
      "// Generated from specs/contracts/asyncapi.v<N>.yaml by `task generate` - do not edit.",
      "// A missing import means a receive operation has no file yet: run `task scaffold`.",
      'import type { Consumers } from "../lib/consumer.ts";',
      ...ids.map((id) => `import { ${id} } from "../consumers/${id}.ts";`),
      "",
      `export const consumers: Consumers = {${ids.length > 0 ? ` ${ids.join(", ")} ` : ""}};`,
      "",
    ].join("\n"),
  );
  console.log(`generated src/generated/consumers.ts - ${ids.length} receive operations`);
}

function scaffold(): void {
  mkdirSync("src/consumers", { recursive: true });
  const written: string[] = [];
  for (const operation of receives()) {
    if (existsSync(file(operation.id))) continue;
    // The payload's type is named after the schema it came from when it has one; the message's name otherwise.
    const names = operation.messages.map(payloadType);
    writeFileSync(
      file(operation.id),
      `import type { ${names.join(", ")} } from "../generated/messages.d.ts";
import type { MessageContext } from "../lib/consumer.ts";

/**
 * ${operation.id} - a message on ${operation.address}
 * Return to accept the message; throw to have it offered again, and put on
 * the dead-letter queue when it has been offered too often.
 * @scaffold Written by \`task scaffold\`. Implement it, then delete this line.
 */
export async function ${operation.id}(context: MessageContext<${names.join(" | ")}>): Promise<void> {
  throw new Error("${operation.id} is not implemented yet.");
}
`,
    );
    written.push(file(operation.id));
  }
  console.log(written.length > 0 ? `scaffold: wrote ${written.join(", ")}` : "scaffold: every receive operation has a file");
}

function check(): void {
  const ids = receives().map((operation) => operation.id);
  if (ids.length === 0) return console.log("consume:check - the contract has no receive operations, so there is nothing to deliver");
  const RECORD = ".local/messages-delivered.json";
  if (!existsSync(RECORD)) {
    console.error(`consume:check failed\n  - ${RECORD} is missing: run the features first (task acceptance does)`);
    process.exit(1);
  }
  const delivered = new Set(JSON.parse(readFileSync(RECORD, "utf8")) as string[]);
  const missing = ids.filter((id) => !delivered.has(id));
  if (missing.length > 0) {
    console.error(
      ["consume:check failed", ...missing.map((id) => `  - no scenario delivered a message to ${id}: the contract says the API accepts it, and nothing shows that it does`), "  Add the scenario, or remove the operation."].join(
        "\n",
      ),
    );
    process.exit(1);
  }
  console.log(`consume:check ok - a scenario delivered a message to each of the ${ids.length} receive operations`);
}

const command = process.argv[2];
if (command === "generate") generate();
else if (command === "scaffold") scaffold();
else if (command === "check") check();
else {
  console.error("consume: generate | scaffold | check");
  process.exit(1);
}
