import { toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import { findBeer } from "./shared.ts";

export async function getBeer({ path }: Context<"getBeer">) {
  return json(200, toBeer(await findBeer(path.beerId)));
}
