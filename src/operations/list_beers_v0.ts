import { toBeer } from "../domain/beer.ts";
import { decodeCursor, encodeCursor } from "../domain/cursor.ts";
import { HttpProblem, json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { readPage } from "../store/beers.ts";

export async function list_beers_v0({ query }: Context<"list_beers_v0">) {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  if (query.cursor !== undefined && !after) {
    throw new HttpProblem(400, "Bad Request", "The cursor is not one this catalogue issued.");
  }
  const { beers, next } = await readPage(query.style, query.limit ?? 20, after);
  return json(200, { items: beers.map(toBeer), next_cursor: next ? encodeCursor(next) : null });
}
