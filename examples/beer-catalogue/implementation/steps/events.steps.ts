// What the catalogue publishes about its beers.
import { Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { idOf } from "./beers.ts";
import { eventPublished, forwarded, noEventPublished, published } from "./events.ts";
import type { ApiWorld } from "./world.ts";

const typeOf = (what: string) => `com.hungovercoders.beer_catalogue.beer.${what}.v1`;

Then(/^an? "(\w+)" event is published for "([^"]*)"$/, async function (this: ApiWorld, what: string, name: string) {
  const id = idOf(this, name);
  const event = await eventPublished(typeOf(what), (candidate) => candidate.subject === id);
  assert.equal((event.data as { beer_id: string }).beer_id, id);
  this.remembered.set("event", event);
});

Then(/^the event says it is an? (\w+) at ([\d.]+)% abv$/, function (this: ApiWorld, style: string, abv: string) {
  const { data } = this.remembered.get("event");
  assert.deepEqual([data.style, data.abv], [style, Number(abv)]);
});

Then("the event names the beer {string}", function (this: ApiWorld, name: string) {
  assert.equal(this.remembered.get("event").data.name, name);
});

Then("the event carries the score {int}", function (this: ApiWorld, score: number) {
  assert.equal(this.remembered.get("event").data.score, score);
});

Then("only one {string} event has been published", async function (this: ApiWorld, what: string) {
  await eventPublished(typeOf(what));
  await forwarded();
  // A moment more for the bus: an event that should not exist would be in flight.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal((await published()).filter((event) => event.type === typeOf(what)).length, 1);
});

Then("no {string} event has been published", async function (this: ApiWorld, what: string) {
  await noEventPublished(typeOf(what));
});
