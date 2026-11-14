import { noContent } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { deleteBeer } from "../store/beers.ts";
import { answering, findBeer } from "./shared.ts";

export async function retireBeer({ path }: Context<"retireBeer">) {
  const beer = await findBeer(path.beerId);
  await answering(() => deleteBeer(beer));
  return noContent();
}
