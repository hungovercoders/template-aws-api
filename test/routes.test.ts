// The implementation backlog, as a gate. The route table itself is generated
// (src/generated/routes.ts); what remains is for every operation to have a
// file, and for that file to be more than the stub `task scaffold` wrote.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { operations } from "../src/lib/contract.ts";

const file = (operationId: string) => `src/operations/${operationId}.ts`;
const ids = operations.map((op) => op.operationId).sort();

test("every operation in the contract has a file in src/operations - run `task scaffold` to create them", () => {
  expect(ids.filter((id) => !existsSync(file(id))), "operations with no file").toEqual([]);
});

test("no operation is still the stub `task scaffold` wrote", () => {
  const stubs = ids.filter((id) => existsSync(file(id)) && readFileSync(file(id), "utf8").includes("@scaffold"));
  expect(stubs, "operations still to implement").toEqual([]);
});
