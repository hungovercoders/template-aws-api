import { byName, toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import * as store from "../store/beers.ts";

export async function list_beers({ query }: Context<"list_beers">) {
  const beers = await store.readBeers(query.style);
  return json(200, { items: beers.map(toBeer).sort(byName) });
}
