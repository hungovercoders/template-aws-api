import { byName, toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import * as store from "../store/beers.ts";

export async function listBeers({ query }: Context<"listBeers">) {
  const beers = await store.listBeers(query.style);
  return json(200, { items: beers.map(toBeer).sort(byName) });
}
