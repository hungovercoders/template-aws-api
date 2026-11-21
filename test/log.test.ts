// What the logger writes: one line per call, in OpenTelemetry's log data model.
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../src/lib/log.ts";
import { continueTrace } from "../src/lib/trace.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
  delete process.env.OTEL_SERVICE_NAME;
});

const lineOf = (spy: { mock: { calls: unknown[][] } }, at = 0) => JSON.parse(spy.mock.calls[at]![0] as string);

test("a line is an OpenTelemetry log record, the logger's base fields among its Attributes", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  createLogger({ request_id: "r1" }).info("request", { status: 200 });
  const line = lineOf(out);
  expect(line).toMatchObject({ SeverityText: "INFO", SeverityNumber: 9, Body: "request", Attributes: { request_id: "r1", status: 200 } });
  expect(new Date(line.Timestamp).toISOString()).toBe(line.Timestamp);
});

test("each level has the data model's severity", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.env.LOG_LEVEL = "debug";
  const log = createLogger();
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");
  expect([0, 1, 2].map((at) => [lineOf(out, at).SeverityText, lineOf(out, at).SeverityNumber])).toEqual([
    ["DEBUG", 5],
    ["INFO", 9],
    ["WARN", 13],
  ]);
  expect([lineOf(err).SeverityText, lineOf(err).SeverityNumber]).toEqual(["ERROR", 17]);
});

test("a line carries the trace and span in force, so a request's lines are found by its trace", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const [, trace, span, flags] = continueTrace("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01").split("-");
  createLogger().info("request");
  expect(lineOf(out)).toMatchObject({ TraceId: trace, SpanId: span, TraceFlags: flags });
  expect(trace).toBe("0af7651916cd43dd8448eb211c80319c");
});

test("a logger can be put in a trace of its own: the forwarder logs each event in the event's", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  continueTrace();
  createLogger({}, "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01").info("event");
  expect(lineOf(out)).toMatchObject({ TraceId: "4bf92f3577b34da6a3ce929d0e0e4736", SpanId: "00f067aa0ba902b7" });
});

test("the Resource says which service wrote the line", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.OTEL_SERVICE_NAME = "beer-catalogue";
  createLogger().info("request");
  expect(lineOf(out).Resource).toMatchObject({ "service.name": "beer-catalogue" });
});

test("errors are logged with their message and stack, not as {}", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  createLogger().error("failed", { error: new Error("boom") });
  const { error } = lineOf(err).Attributes;
  expect(error.message).toBe("boom");
  expect(error.stack).toContain("boom");
});

test("LOG_LEVEL silences lines below it", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.LOG_LEVEL = "warn";
  const log = createLogger();
  log.info("quiet");
  log.warn("loud");
  expect(out.mock.calls.map((call) => JSON.parse(call[0] as string).Body)).toEqual(["loud"]);
});
