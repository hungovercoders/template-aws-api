import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { inherited, problems, type Ruleset } from "../scripts/rulesets.ts";

const HOUSE = "rules/house.yaml";
const AT = ".spectral.yaml";

test("the house rules hold their own rules and those of Spectral's rulesets they extend", async () => {
  const openapi = await inherited(HOUSE);
  expect(openapi).toContain("house-property-names-snake-case");
  expect(openapi).toContain("oas3-schema");
  expect(openapi).toContain("oas3-api-servers");
  const asyncapi = await inherited("rules/asyncapi.yaml");
  expect(asyncapi).toContain("house-channel-names-snake-case");
  expect(asyncapi).toContain("asyncapi-schema");
  expect(await inherited("rules/datacontract.yaml")).toContain("house-data-property-names-snake-case");
});

test("the template's own .spectral.yaml keeps the house rules", async () => {
  const { parse } = await import("yaml");
  const { readFileSync } = await import("node:fs");
  expect(problems(parse(readFileSync(AT, "utf8")) as Ruleset, AT, HOUSE, await inherited(HOUSE))).toEqual([]);
});

test("an API's ruleset must extend the house rules, by any spelling of their path", async () => {
  const house = await inherited(HOUSE);
  for (const kept of [["./rules/house.yaml"], ["rules/house.yaml"], "./rules/house.yaml", [["./rules/house.yaml", "all"]], ["./other.yaml", "./rules/house.yaml"]]) {
    expect(problems({ extends: kept as Ruleset["extends"] }, AT, HOUSE, house)).toEqual([]);
  }
  for (const dropped of [undefined, [], ["spectral:oas"], ["./other.yaml"], ["./rules/house.yaml", "off"], [["./rules/house.yaml", "off"]]]) {
    expect(problems({ extends: dropped as Ruleset["extends"] }, AT, HOUSE, house)).toEqual([expect.stringContaining("does not extend rules/house.yaml")]);
  }
});

test("an API may add rules of its own and make an inherited rule fail where it did not", async () => {
  const house = await inherited(HOUSE);
  const ruleset: Ruleset = {
    extends: ["./rules/house.yaml"],
    rules: {
      "property-description-required": { severity: "info", given: "$..properties[*]", then: { field: "description", function: "truthy" } },
      "oas3-api-servers": "error",
      "info-contact": "warn",
      "operation-tag-defined": true,
      "operation-description": { severity: "error" },
    },
  };
  expect(problems(ruleset, AT, HOUSE, house)).toEqual([]);
});

test("an API may not switch an inherited rule off, soften it or redefine it", async () => {
  const house = await inherited(HOUSE);
  const extend = { extends: ["./rules/house.yaml"] };
  expect(problems({ ...extend, rules: { "house-property-names-snake-case": "off" } }, AT, HOUSE, house)).toEqual([expect.stringContaining('sets house-property-names-snake-case to "off"')]);
  expect(problems({ ...extend, rules: { "house-enum-values-snake-case": false } }, AT, HOUSE, house)).toEqual([expect.stringContaining("house-enum-values-snake-case")]);
  expect(problems({ ...extend, rules: { "oas3-schema": "hint" } }, AT, HOUSE, house)).toEqual([expect.stringContaining('sets oas3-schema to "hint"')]);
  expect(problems({ ...extend, rules: { "house-paths-snake-case": { severity: "info" } } }, AT, HOUSE, house)).toEqual([expect.stringContaining('to "info"')]);
  expect(problems({ ...extend, rules: { "house-operation-id-snake-case": 2 } }, AT, HOUSE, house)).toEqual([expect.stringContaining("to 2")]);
  const loose = { given: "$.paths[*][*].operationId", then: { function: "pattern", functionOptions: { match: ".*" } } };
  expect(problems({ ...extend, rules: { "house-operation-id-snake-case": loose } }, AT, HOUSE, house)).toEqual([expect.stringContaining("redefines house-operation-id-snake-case")]);
});

test("an API may not exempt files or paths from the rules", async () => {
  const house = await inherited(HOUSE);
  const extend = { extends: ["./rules/house.yaml"] };
  expect(problems({ ...extend, overrides: [{ files: ["specs/contracts/openapi.yaml#/paths"], rules: { "house-paths-snake-case": "off" } }] }, AT, HOUSE, house)).toEqual([expect.stringContaining("overrides")]);
  expect(problems({ ...extend, except: { "specs/contracts/openapi.yaml#/paths": ["house-paths-snake-case"] } }, AT, HOUSE, house)).toEqual([expect.stringContaining("except")]);
});

test("the gate fails a weakened or missing ruleset and passes the house rules themselves", () => {
  const dir = mkdtempSync(join(tmpdir(), "rulesets-"));
  const run = (api: string) => spawnSync("node", ["--import", "tsx", "scripts/rulesets.ts", resolve(dir, api), HOUSE], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  writeFileSync(join(dir, "weak.yaml"), `extends: ["${resolve(HOUSE)}"]\nrules:\n  house-property-names-snake-case: off\n`);
  const weak = run("weak.yaml");
  expect(weak.status).toBe(1);
  expect(weak.stderr).toContain("weak.yaml would weaken the house rules");
  expect(run("missing.yaml").stderr).toContain("missing.yaml is missing");
  expect(run(resolve(HOUSE)).status).toBe(0);
  writeFileSync(join(dir, "own.yaml"), `extends: ["${resolve(HOUSE)}"]\nrules:\n  oas3-api-servers: error\n`);
  expect(run("own.yaml").status).toBe(0);
});
