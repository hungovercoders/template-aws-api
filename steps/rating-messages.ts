// Ratings that arrive as messages on the catalogue's queue.
import { Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { currently, idOf } from "./beers.ts";
import { deadLetters, deliver, eventually, messageFor, settled } from "./messages.ts";
import type { ApiWorld } from "./world.ts";

const OPERATION = "receive_beer_rating";
const rating = (beer_id: string, score: number) => messageFor(OPERATION, { beer_id, score });

When(/^the taproom sends a rating of ([\d.]+) for "([^"]*)"$/, async function (this: ApiWorld, score: string, name: string) {
  await deliver(OPERATION, rating(idOf(this, name), Number(score)));
});

When(/^the taproom sends the same rating of (\d+) for "([^"]*)" twice$/, async function (this: ApiWorld, score: string, name: string) {
  // One event, delivered twice - as a queue may.
  const event = rating(idOf(this, name), Number(score));
  await deliver(OPERATION, event);
  await deliver(OPERATION, event);
});

When("the taproom sends a rating of {int} for a beer that is not in the catalogue", async function (this: ApiWorld, score: number) {
  await deliver(OPERATION, rating("no-such-beer", score));
});

Then(/^"([^"]*)" comes to have (\d+) ratings? averaging ([\d.]+)$/, async function (this: ApiWorld, name: string, count: string, average: string) {
  const expected = async () => {
    const beer = await currently(this, name);
    assert.ok(beer, `"${name}" is in the catalogue`);
    assert.deepEqual([beer.rating_count, beer.average_rating], [Number(count), Number(average)]);
  };
  await eventually(expected);
  // And it stays so once every message has been dealt with.
  await settled();
  await expected();
});

Then("the message is put aside as not matching the contract", async function (this: ApiWorld) {
  const [letter] = await eventually(async () => {
    const letters = await deadLetters();
    assert.equal(letters.length, 1, "one message is on the dead-letter queue");
    return letters;
  });
  assert.match(letter!.reason ?? "", /does not match the contract/);
});

Then("the message is put aside because {string}", async function (this: ApiWorld, reason: string) {
  const [letter] = await eventually(async () => {
    const letters = await deadLetters();
    assert.equal(letters.length, 1, "one message is on the dead-letter queue");
    return letters;
  });
  assert.equal(letter!.reason, reason);
});
