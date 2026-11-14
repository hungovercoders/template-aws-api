import { oneDecimal, toBeer } from "../domain/beer.ts";
import { json } from "../lib/problem.ts";
import type { Context } from "../lib/router.ts";
import * as store from "../store/beers.ts";
import { answering, findBeer } from "./shared.ts";

export async function update_beer({ path, body }: Context<"update_beer">) {
  const current = await findBeer(path.beer_id);
  const changes = {
    ...body,
    ...(body.name === undefined ? {} : { name: body.name.trim() }),
    ...(body.abv === undefined ? {} : { abv: oneDecimal(body.abv) }),
  };
  const updated = await answering(() => store.applyChanges(current, changes, new Date().toISOString()));
  return json(200, toBeer(updated));
}
