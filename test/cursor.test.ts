import { expect, test } from "vitest";
import { decodeCursor, encodeCursor } from "../src/domain/cursor.ts";

const end = { order: "eclair noir|éclair noir", id: "3f6c1c2e-6a53-4d5e-9d0b-0a0f6d2a9d11" };

test("a cursor round-trips the place a page ended", () => {
  expect(decodeCursor(encodeCursor(end))).toEqual(end);
});

test("a cursor is opaque and safe to put in a URL", () => {
  expect(encodeCursor(end)).toMatch(/^[A-Za-z0-9_-]+$/);
});

test.each([
  ["not base64 json", "made-up"],
  ["the wrong shape", Buffer.from(JSON.stringify({ order: "a", id: end.id })).toString("base64url")],
  ["too many parts", Buffer.from(JSON.stringify(["a", end.id, "b"])).toString("base64url")],
  ["an id that is not a uuid", Buffer.from(JSON.stringify(["a", "nope"])).toString("base64url")],
  ["an empty place", Buffer.from(JSON.stringify(["", end.id])).toString("base64url")],
  ["a place that is not text", Buffer.from(JSON.stringify([1, end.id])).toString("base64url")],
])("a cursor that is %s is rejected", (_what, cursor) => {
  expect(decodeCursor(cursor)).toBeUndefined();
});
