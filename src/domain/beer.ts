import type { components } from "../generated/api.d.ts";

export type Beer = components["schemas"]["Beer"];
export type NewBeer = components["schemas"]["NewBeer"];
export type BeerChanges = components["schemas"]["BeerChanges"];

/** A beer as stored: the contract's Beer, with the rating total instead of the average. */
export type StoredBeer = Omit<Beer, "average_rating"> & { rating_total: number };

/**
 * Names are unique ignoring case and surrounding spaces; this is the form they
 * are compared in. Upper- then lower-casing folds case fully, so "Straße" and
 * "STRASSE" match; the dot that lower-casing "İ" leaves behind is dropped so
 * it matches "i".
 */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .normalize("NFKC");
}

/**
 * A strength to one decimal place, halves rounding up. Rounds the decimal the
 * caller wrote, not its binary approximation: 1.15 * 10 is 11.499999999999998
 * in floating point, and must still round to 1.2.
 */
export function oneDecimal(value: number): number {
  return Math.round(Number((value * 10).toPrecision(12))) / 10;
}

/** Mean score to one decimal place, halves rounding up; null until there is a rating. */
export function averageOf(count: number, total: number): number | null {
  // Whole numbers throughout, so the division happens once and nothing is lost before rounding.
  return count === 0 ? null : Math.round((total * 10) / count) / 10;
}

export function toBeer({ rating_total, ...beer }: StoredBeer): Beer {
  return { ...beer, average_rating: averageOf(beer.rating_count, rating_total) };
}

/**
 * A beer's place in the catalogue: names in alphabetical order, ignoring case
 * and accents, so "Éclair" sorts with the Es and not after Z. The exact name
 * key follows, to order names that differ only by accent.
 */
export function orderKey(name: string): string {
  const key = nameKey(name);
  return `${key.normalize("NFD").replace(/\p{M}+/gu, "")}|${key}`;
}
