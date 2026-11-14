import type { components } from "../generated/api.d.ts";

export type Beer = components["schemas"]["Beer"];
export type NewBeer = components["schemas"]["NewBeer"];
export type BeerChanges = components["schemas"]["BeerChanges"];

/** A beer as stored: the contract's Beer, with the rating total instead of the average. */
export type StoredBeer = Omit<Beer, "average_rating"> & { rating_total: number };

/** Names are unique ignoring case and surrounding spaces; this is the form they are compared in. */
export function nameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

/** Strength and averages are recorded to one decimal place. */
export function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Mean score to one decimal place; null until there is a rating. */
export function averageOf(count: number, total: number): number | null {
  return count === 0 ? null : oneDecimal(total / count);
}

export function toBeer({ rating_total, ...beer }: StoredBeer): Beer {
  return { ...beer, average_rating: averageOf(beer.rating_count, rating_total) };
}

/** Catalogue order: by name, ignoring case. */
export function byName(a: { name: string }, b: { name: string }): number {
  const [x, y] = [nameKey(a.name), nameKey(b.name)];
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
