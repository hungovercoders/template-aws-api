// The trace context every request's log lines carry (src/lib/trace.ts).
import { expect, test } from "vitest";
import { continueTrace, traceId, traceparent } from "../src/lib/trace.ts";

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const SPAN = "b7ad6b7169203331";

test("a valid traceparent carries its trace on, with a span of this API's own", () => {
  const carried = continueTrace(`00-${TRACE}-${SPAN}-00`);
  expect(carried).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-00$`));
  expect(carried).not.toContain(SPAN);
  expect(traceparent()).toBe(carried);
  expect(traceId()).toBe(TRACE);
  // A later version is read as far as this one goes.
  expect(continueTrace(`01-${TRACE}-${SPAN}-01-extra`)).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
});

test.each([
  ["nothing", undefined],
  ["an empty header", ""],
  ["something else entirely", "garbage"],
  ["an all-zero trace id", `00-${"0".repeat(32)}-${SPAN}-01`],
  ["an all-zero parent id", `00-${TRACE}-${"0".repeat(16)}-01`],
  ["upper case hex", `00-${TRACE.toUpperCase()}-${SPAN}-01`],
  ["the forbidden version", `ff-${TRACE}-${SPAN}-01`],
  ["version 00 with more after the flags", `00-${TRACE}-${SPAN}-01-extra`],
])("%s starts a new trace", (_, incoming) => {
  const fresh = continueTrace(incoming);
  expect(fresh).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  expect(fresh.toLowerCase()).not.toContain(TRACE);
});
