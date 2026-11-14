// The implementation backlog for messages, as a gate. The table of consumers
// is generated (src/generated/consumers.ts); what remains is for every
// receive operation to have a file, and for that file to be more than the
// stub `task scaffold` wrote.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { asyncOperations } from "../src/generated/async-operations.ts";

const file = (operationId: string) => `src/consumers/${operationId}.ts`;
const ids = (asyncOperations as readonly { id: string; action: string }[])
  .filter((operation) => operation.action === "receive")
  .map((operation) => operation.id)
  .sort();

test("every receive operation in the contract has a file in src/consumers - run `task scaffold` to create them", () => {
  expect(ids.filter((id) => !existsSync(file(id))), "receive operations with no file").toEqual([]);
});

test("no consumer is still the stub `task scaffold` wrote", () => {
  const stubs = ids.filter((id) => existsSync(file(id)) && readFileSync(file(id), "utf8").includes("@scaffold"));
  expect(stubs, "consumers still to implement").toEqual([]);
});
