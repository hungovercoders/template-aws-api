import { expect, test } from "vitest";
import { operations } from "../src/lib/contract.ts";
import { routes } from "../src/routes.ts";

const contract = operations.map((op) => op.operationId).sort();
const implemented = Object.keys(routes).sort();

test("every operation in the contract has a handler in src/routes.ts", () => {
  expect(contract.filter((id) => !implemented.includes(id)), "operations with no handler").toEqual([]);
});

test("every handler in src/routes.ts is an operation in the contract", () => {
  expect(implemented.filter((id) => !contract.includes(id)), "handlers with no operation").toEqual([]);
});
