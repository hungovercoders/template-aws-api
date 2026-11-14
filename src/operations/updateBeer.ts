import { oneDecimal, toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import * as store from "../store/beers.ts";
import { answering, findBeer } from "./shared.ts";

export async function updateBeer({ path, body }: Context<"updateBeer">) {
  const current = await findBeer(path.beerId);
  const changes = {
    ...body,
    ...(body.name === undefined ? {} : { name: body.name.trim() }),
    ...(body.abv === undefined ? {} : { abv: oneDecimal(body.abv) }),
  };
  const updated = await answering(() => store.updateBeer(current, changes, new Date().toISOString()));
  return json(200, toBeer(updated));
}
