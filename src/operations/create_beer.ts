import { randomUUID } from "node:crypto";
import { oneDecimal, toBeer, type StoredBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { putNewBeer } from "../store/beers.ts";
import { answering } from "./shared.ts";

export async function create_beer({ body }: Context<"create_beer">) {
  const now = new Date().toISOString();
  const beer: StoredBeer = {
    id: randomUUID(),
    name: body.name.trim(),
    style: body.style,
    abv: oneDecimal(body.abv),
    rating_count: 0,
    rating_total: 0,
    created_at: now,
    updated_at: now,
  };
  await answering(() => putNewBeer(beer));
  return json(201, toBeer(beer), { location: `/beers/${beer.id}` });
}
