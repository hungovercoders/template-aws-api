import { noContent } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { deleteBeer } from "../store/beers.ts";
import { answering, findBeer } from "./shared.ts";

export async function retire_beer({ path }: Context<"retire_beer">) {
  const beer = await findBeer(path.beer_id);
  await answering(() => deleteBeer(beer));
  return noContent();
}
