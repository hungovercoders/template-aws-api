// What `task changelog:generate` writes from the history (scripts/changelog.ts).
import { expect, test } from "vitest";
import { entryOf, render } from "../scripts/changelog.ts";

test("a pull request is listed by its title, with its kind and a link to it", () => {
  expect(entryOf({ day: "2026-11-21", subject: "Merge pull request #121 from org/branch", body: "feat: the raw JSON is kept 7 years\n\nmore" })).toEqual({
    day: "2026-11-21",
    kind: "feat",
    title: "the raw JSON is kept 7 years",
    pull: 121,
  });
});

test("a commit made straight on the branch is listed by its subject; a merge of branches is not listed", () => {
  expect(entryOf({ day: "2026-11-15", subject: "fix(router): a 405 names the methods allowed", body: "" })).toEqual({ day: "2026-11-15", kind: "fix", title: "a 405 names the methods allowed" });
  expect(entryOf({ day: "2026-11-15", subject: "Merge branch 'main' into example/spec", body: "" })).toBeUndefined();
});

test("a title without a known kind is listed as it is, under Other", () => {
  expect(entryOf({ day: "2026-11-14", subject: "stack: features run on the emulator", body: "" })).toEqual({ day: "2026-11-14", kind: "Other", title: "stack: features run on the emulator" });
  expect(entryOf({ day: "2026-11-14", subject: "Merge pull request #7 from org/branch", body: "" })!.title).toBe("Merge pull request #7 from org/branch");
});

test("the changelog is by day, newest first, and by kind in a fixed order within a day", () => {
  const text = render([
    { day: "2026-11-21", subject: "Merge pull request #3 from org/b", body: "fix: three" },
    { day: "2026-11-21", subject: "Merge pull request #2 from org/b", body: "feat: two" },
    { day: "2026-11-20", subject: "docs: one", body: "" },
  ]);
  expect(text).toContain("## 2026-11-21\n\n### Features\n\n- two ([#2](../../pull/2))\n\n### Fixes\n\n- three ([#3](../../pull/3))\n\n## 2026-11-20\n\n### Documentation\n\n- one\n");
  expect(text.indexOf("## 2026-11-21")).toBeLessThan(text.indexOf("## 2026-11-20"));
});

test("the same history always gives the same changelog", () => {
  const history = [{ day: "2026-11-21", subject: "Merge pull request #1 from org/b", body: "ci: one" }];
  expect(render(history)).toBe(render(history));
});
