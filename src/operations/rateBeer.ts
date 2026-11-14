import { toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { addRating } from "../store/beers.ts";
import { answering } from "./shared.ts";

export async function rateBeer({ path, body }: Context<"rateBeer">) {
  const beer = await answering(() => addRating(path.beerId, body.score, new Date().toISOString()));
  return json(201, toBeer(beer));
}
