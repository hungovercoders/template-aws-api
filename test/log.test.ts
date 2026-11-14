import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../src/lib/log.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LOG_LEVEL;
});

test("a line is one JSON object carrying the logger's base fields", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  createLogger({ request_id: "r1" }).info("request", { status: 200 });
  expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual({ level: "info", message: "request", request_id: "r1", status: 200 });
});

test("errors are logged with their message and stack, not as {}", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  createLogger().error("failed", { error: new Error("boom") });
  const line = JSON.parse(err.mock.calls[0]![0] as string);
  expect(line.error.message).toBe("boom");
  expect(line.error.stack).toContain("boom");
});

test("LOG_LEVEL silences lines below it", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.LOG_LEVEL = "warn";
  const log = createLogger();
  log.info("quiet");
  log.warn("loud");
  expect(out.mock.calls.map((call) => JSON.parse(call[0] as string).message)).toEqual(["loud"]);
});
