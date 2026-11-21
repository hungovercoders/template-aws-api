import { noContent } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { deleteBeer } from "../store/beers.ts";
import { answering } from "./shared.ts";

export async function retire_beer_v0({ path }: Context<"retire_beer_v0">) {
  await answering(() => deleteBeer(path.beer_id));
  return noContent();
}
