import { toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { findBeer } from "./shared.ts";

export async function get_beer_v0({ path }: Context<"get_beer_v0">) {
  return json(200, toBeer(await findBeer(path.beer_id)));
}
