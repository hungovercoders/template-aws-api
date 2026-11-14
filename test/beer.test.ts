import { expect, test } from "vitest";
import { averageOf, nameKey, oneDecimal, orderKey } from "../src/domain/beer.ts";

test("a beer with no ratings has no average", () => {
  expect(averageOf(0, 0)).toBeNull();
});

test("the average is the mean to one decimal place", () => {
  expect(averageOf(4, 15)).toBe(3.8);
  expect(averageOf(3, 10)).toBe(3.3);
  expect(averageOf(2, 9)).toBe(4.5);
});

test("an average ending in 5 at the second decimal rounds up", () => {
  expect(averageOf(20, 23)).toBe(1.2); // 1.15
  expect(averageOf(20, 87)).toBe(4.4); // 4.35
  expect(averageOf(20, 21)).toBe(1.1); // 1.05
});

test("a strength ending in 5 at the second decimal rounds up, consistently", () => {
  expect(oneDecimal(1.15)).toBe(1.2);
  expect(oneDecimal(5.65)).toBe(5.7);
  expect(oneDecimal(5.64)).toBe(5.6);
  expect(oneDecimal(0)).toBe(0);
  expect(oneDecimal(5e-324)).toBe(0);
  expect(oneDecimal(20)).toBe(20);
});

test("names are compared ignoring case and surrounding spaces", () => {
  expect(nameKey("  morning AFTER ")).toBe(nameKey("Morning After"));
  expect(nameKey("Morning  After")).not.toBe(nameKey("Morning After"));
});

test("case is ignored in every alphabet, not only A to Z", () => {
  expect(nameKey("Straße")).toBe(nameKey("STRASSE"));
  expect(nameKey("İpa")).toBe(nameKey("ipa"));
  expect(nameKey("ÉCLAIR")).toBe(nameKey("éclair"));
  expect(nameKey("Eclair")).not.toBe(nameKey("Éclair"));
});

test("space that only appears once the name is normalised is still trimmed", () => {
  expect(nameKey("\u3000Morning After\u2003")).toBe(nameKey("Morning After"));
});

const inCatalogueOrder = (names: string[]) => [...names].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));

test("the catalogue is ordered by name, ignoring case", () => {
  expect(inCatalogueOrder(["morning After", "Last Orders", "hair of the Dog"])).toEqual(["hair of the Dog", "Last Orders", "morning After"]);
});

test("accented names sort alphabetically, not after Z", () => {
  expect(inCatalogueOrder(["Zebra Lager", "Éclair Stout", "Amber Ale"])).toEqual(["Amber Ale", "Éclair Stout", "Zebra Lager"]);
});

test("names that differ only by accent have different places", () => {
  expect(orderKey("Eclair")).not.toBe(orderKey("Éclair"));
});
