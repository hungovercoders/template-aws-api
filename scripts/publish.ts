// What follows from the `send` operations of the AsyncAPI contract, for
// publishing (src/lib/outbox.ts):
//   node scripts/publish.ts generate   - src/generated/events.ts: one typed function for each event the
//                                        API publishes, which makes the CloudEvent and holds it to the contract
//   node scripts/publish.ts check      - gate: every event the contract says the API publishes was
//                                        published in a scenario of the last full feature run
// It reads what `task generate` wrote from the contract, so it needs no
// AsyncAPI tooling of its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { operations, payloadType } from "../tools/asyncapi/operations.ts";

const sends = () => operations("send");

function generate(): void {
  // One function per message, named after it: beer_created(data, subject).
  const messages = new Map(sends().flatMap((operation) => operation.messages.filter((message) => message.type).map((message) => [message.name, message] as const)));
  const lines = [...messages.values()].map((message) => {
    const named = payloadType(message);
    return [
      `/** ${message.type} - \`subject\` is what it happened to. Put the result in the transaction that makes the change: \`outbox(event)\`. */`,
      `export const ${message.name} = (data: ${named}["data"], subject?: string): ${named} => events.create<${named}>("${message.type}", data, subject);`,
    ].join("\n");
  });
  const names = [...new Set(lines.map((line) => /\): (\w+) =>/.exec(line)![1]!))];
  mkdirSync("src/generated", { recursive: true });
  writeFileSync(
    "src/generated/events.ts",
    [
      "// Generated from specs/asyncapi.v<N>.yaml by `task generate` - do not edit.",
      "// Every event this API publishes: make one with its function, which holds it",
      "// to the contract, and write it with the change it is about (src/lib/outbox.ts).",
      ...(lines.length > 0 ? ['import { events } from "../lib/cloudevents.ts";', `import type { ${names.join(", ")} } from "./messages.d.ts";`, "", ...lines] : ["export {};"]),
      "",
    ].join("\n"),
  );
  console.log(`generated src/generated/events.ts - ${lines.length} events to publish`);
}

function check(): void {
  const expected = new Map(sends().flatMap((operation) => operation.messages.filter((message) => message.type).map((message) => [message.type!, operation.id] as const)));
  if (expected.size === 0) return console.log("publish:check - the contract has no send operations, so there is nothing to publish");
  const RECORD = ".local/events-published.json";
  if (!existsSync(RECORD)) {
    console.error(`publish:check failed\n  - ${RECORD} is missing: run the features first (task acceptance does)`);
    process.exit(1);
  }
  const published = new Set(JSON.parse(readFileSync(RECORD, "utf8")) as string[]);
  const missing = [...expected].filter(([type]) => !published.has(type));
  if (missing.length > 0) {
    console.error(
      [
        "publish:check failed",
        ...missing.map(([type, operation]) => `  - no scenario saw ${type} published (${operation}): the contract promises an event the behaviour spec never shows`),
        "  Add the scenario, or remove the operation.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`publish:check ok - a scenario saw each of the ${expected.size} events the contract says the API publishes`);
}

const command = process.argv[2];
if (command === "generate") generate();
else if (command === "check") check();
else {
  console.error("publish: generate | check");
  process.exit(1);
}
