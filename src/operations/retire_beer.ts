import { noContent } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { deleteBeer } from "../store/beers.ts";
import { answering } from "./shared.ts";

export async function retire_beer({ path }: Context<"retire_beer">) {
  await answering(() => deleteBeer(path.beer_id));
  return noContent();
}
