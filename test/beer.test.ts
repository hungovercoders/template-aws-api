import { expect, test } from "vitest";
import { averageRating, byName, nameKey } from "../src/domain/beer.ts";

test("a beer with no ratings has no average", () => {
  expect(averageRating(0, 0)).toBeNull();
});

test("the average is the mean to one decimal place", () => {
  expect(averageRating(4, 15)).toBe(3.8);
  expect(averageRating(3, 10)).toBe(3.3);
  expect(averageRating(2, 9)).toBe(4.5);
});

test("names are compared ignoring case and surrounding spaces", () => {
  expect(nameKey("  morning AFTER ")).toBe(nameKey("Morning After"));
  expect(nameKey("Morning  After")).not.toBe(nameKey("Morning After"));
});

test("the catalogue is ordered by name, ignoring case", () => {
  const names = ["morning After", "Last Orders", "hair of the Dog"].map((name) => ({ name }));
  expect(names.sort(byName).map((b) => b.name)).toEqual(["hair of the Dog", "Last Orders", "morning After"]);
});
