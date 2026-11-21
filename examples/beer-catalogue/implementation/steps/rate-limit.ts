// Glue for specs/features/rate-limit.feature: this.flood() calls faster than the
// contract's x-rate-limit and counts the answers; each is held to the contract.
import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { ApiWorld } from "./world.ts";

const answers = (world: ApiWorld): Record<number, number> => world.remembered.get("answers");

When("a caller lists the beers faster than the catalogue allows", async function (this: ApiWorld) {
  this.remembered.set("answers", await this.flood("GET", "/v0/beers"));
});

Then("some of those calls are told to slow down", function (this: ApiWorld) {
  assert.ok((answers(this)[429] ?? 0) > 0, `no call was told to slow down: ${JSON.stringify(answers(this))}`);
});

Then("the rest list the beers", function (this: ApiWorld) {
  const { 200: listed = 0, 429: refused = 0, ...other } = answers(this);
  assert.ok(listed > 0, "no call listed the beers");
  assert.deepEqual(other, {}, `calls were answered with something else: ${JSON.stringify(other)}`);
  assert.ok(listed + refused > 0);
});
