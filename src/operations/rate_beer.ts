import { toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { addRating } from "../store/beers.ts";
import { answering } from "./shared.ts";

export async function rate_beer({ path, body }: Context<"rate_beer">) {
  const beer = await answering(() => addRating(path.beer_id, body.score, new Date().toISOString()));
  return json(201, toBeer(beer));
}
