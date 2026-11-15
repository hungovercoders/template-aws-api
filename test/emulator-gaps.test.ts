// What `task emulator:gaps` reports, without an emulator: which gaps are this
// repository's, what a closed one asks for, and how its issue is found again.
import { describe, expect, test } from "vitest";
import { applies, issue, next, type Outcome, report, summary } from "../tools/emulator/report.ts";

const gap = (over: Partial<Outcome> = {}): Outcome => ({
  id: "queue-url-host",
  kind: "workaround",
  gap: "A queue's URL names AWS.",
  then: "Make the clients with no option.",
  where: ["src/lib/consumer.ts", "local/queue.ts"],
  result: "still-needed",
  seconds: 1.4,
  ...over,
});

describe("which gaps are tested", () => {
  test("a gap is this repository's while any file it names is here", () => {
    expect(applies(gap(), (path) => path === "local/queue.ts")).toBe(true);
  });

  test("a gap whose files went with a removed component is not tested", () => {
    expect(applies(gap(), () => false)).toBe(false);
  });
});

describe("the report", () => {
  test("says every gap is still there when none has closed", () => {
    const text = report([gap()], "1.0.365");
    expect(text).toContain("AWS Emulator 1.0.365: 1 gaps tested");
    expect(text).toContain("still needed");
    expect(text).toContain("Nothing to remove");
  });

  test("names what to remove, and where, for a gap that has closed", () => {
    const text = report([gap({ result: "closed" })], "1.0.400");
    expect(text).toContain("queue-url-host: the gap has closed. Remove the workaround.");
    expect(text).toContain("Make the clients with no option.");
    expect(text).toContain("src/lib/consumer.ts, local/queue.ts");
  });

  test("shows why a test could not tell", () => {
    const text = report([gap({ result: "unknown", detail: "Error: terraform init failed" })], "1.0.365");
    expect(text).toContain("could not tell");
    expect(text).toContain("terraform init failed");
  });

  test("what a closed gap asks for depends on its kind", () => {
    expect(next(gap())).toBe("Remove the workaround");
    expect(next(gap({ kind: "blocked", issue: 84 }))).toBe("Unblock #84");
    expect(next(gap({ kind: "limit" }))).toBe("Bring the testing guide up to date");
  });

  test("the summary for a pull request has a row for each gap", () => {
    const text = summary([gap(), gap({ id: "s3-control", result: "closed" })], "1.0.400");
    expect(text).toContain("| `queue-url-host` | workaround | still needed |");
    expect(text).toContain("| `s3-control` | workaround | the gap has closed | Remove the workaround:");
  });
});

describe("the issue for a closed gap", () => {
  test("has a title with no version, so a later run finds it rather than opening another", () => {
    const first = issue(gap({ result: "closed" }), "1.0.400");
    const later = issue(gap({ result: "closed" }), "1.0.412");
    expect(first.title).toBe("Emulator gap closed: queue-url-host");
    expect(later.title).toBe(first.title);
    expect(first.body).toContain("AWS Emulator 1.0.400");
  });

  test("says what done is, by kind, and always to remove the gap from the list", () => {
    expect(issue(gap({ result: "closed" }), "1").body).toContain("The workaround is gone");
    expect(issue(gap({ result: "closed", kind: "blocked", issue: 84 }), "1").body).toContain("#84 says this no longer blocks it");
    expect(issue(gap({ result: "closed", kind: "limit" }), "1").body).toContain("`docs/testing.md` no longer says");
    expect(issue(gap({ result: "closed" }), "1").body).toContain("removed from `tools/emulator/gaps/`");
  });
});
