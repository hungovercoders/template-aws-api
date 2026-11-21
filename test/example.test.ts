// What an example's overlay may hold (scripts/example.ts): only what an API owns, at its phase's stage.
import { expect, test } from "vitest";
import { overlayProblems } from "../scripts/example.ts";

const skeleton = new Set(["src/router.ts", "Taskfile.yml"]);

test("the spec phase owns specs/ and is at stage spec", () => {
  expect(overlayProblems("spec", ["specs/openapi.v0.yaml", "README.md", ".stage"], skeleton, "spec")).toEqual([]);
  expect(overlayProblems("spec", ["README.md", ".stage"], skeleton, "spec")).toEqual([expect.stringContaining("has no specs/")]);
  expect(overlayProblems("spec", ["specs/openapi.v0.yaml"], skeleton, "implemented")).toEqual([expect.stringContaining('the spec phase is at stage "spec"')]);
});

test("the implementation phase adds code, never the spec", () => {
  expect(overlayProblems("implementation", ["src/operations/list_v0.ts", "steps/things.ts", ".stage"], skeleton, "implemented")).toEqual([]);
  expect(overlayProblems("implementation", ["specs/openapi.v0.yaml"], skeleton, "implemented")).toEqual([expect.stringContaining("change it there")]);
});

test("no phase holds a skeleton file: the skeleton changes on main", () => {
  expect(overlayProblems("implementation", ["src/router.ts"], skeleton, "implemented")).toEqual([expect.stringContaining("src/router.ts is a skeleton file")]);
});
