// Glue for specs/features: each sentence drives the API over HTTP only.
// ApiWorld.call holds every response to the contract, so these steps assert
// behaviour and leave shape to the OpenAPI document.
import { type DataTable, Given, Then, When } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ApiWorld, Json } from "./world.ts";

async function addBeer(world: ApiWorld, name: string, style: string, abv: number): Promise<Json> {
  const { status, body } = await world.call("POST", "/beers", { name, style, abv });
  assert.equal(status, 201, `adding "${name}" to the catalogue: ${JSON.stringify(body)}`);
  world.remembered.set(name, body);
  return body;
}

function idOf(world: ApiWorld, name: string): string {
  const beer = world.remembered.get(name);
  assert.ok(beer, `the scenario has not added a beer named "${name}"`);
  return beer.id;
}

async function rate(world: ApiWorld, name: string, score: number) {
  return world.call("POST", `/beers/${idOf(world, name)}/ratings`, { score });
}

function expectStatus(world: ApiWorld, status: number) {
  assert.equal(world.last.status, status, `expected ${status}, got ${world.last.status}: ${JSON.stringify(world.last.body)}`);
}

function expectInvalid(world: ApiWorld, field?: string) {
  expectStatus(world, 400);
  const errors: Json[] = world.last.body.errors ?? [];
  assert.ok(errors.length > 0, "the problem lists what is invalid");
  if (field) {
    assert.ok(
      errors.some((e) => e.pointer === `/${field}` || e.message.includes(`'${field}'`)),
      `one of the errors points at ${field}: ${JSON.stringify(errors)}`,
    );
  }
}

// --- Given ------------------------------------------------------------------

Given(/^the catalogue has the beer "([^"]*)", an? (\w+) at ([\d.]+)% abv$/, async function (this: ApiWorld, name: string, style: string, abv: string) {
  await addBeer(this, name, style, Number(abv));
});

Given("the catalogue has these beers:", async function (this: ApiWorld, table: DataTable) {
  for (const row of table.hashes()) await addBeer(this, row.name!, row.style!, Number(row.abv));
});

Given("staff have retired {string}", async function (this: ApiWorld, name: string) {
  await this.call("DELETE", `/beers/${idOf(this, name)}`);
  expectStatus(this, 204);
});

Given(/^"([^"]*)" has been rated ([\d, and]+)$/, async function (this: ApiWorld, name: string, scores: string) {
  for (const score of scores.match(/\d+/g) ?? []) {
    await rate(this, name, Number(score));
    expectStatus(this, 201);
  }
});

// --- When -------------------------------------------------------------------

When(/^staff add the beer "([^"]*)", an? (\w+) at ([\d.]+)% abv$/, async function (this: ApiWorld, name: string, style: string, abv: string) {
  const { status, body } = await this.call("POST", "/beers", { name, style, abv: Number(abv) });
  if (status === 201) this.remembered.set(name, body);
});

When(/^staff try to add a beer with (.+)$/, async function (this: ApiWorld, problem: string) {
  const valid = { name: "Morning After", style: "ipa", abv: 5.6 };
  const invalid: Record<string, Json> = {
    "no name": { style: valid.style, abv: valid.abv },
    "a blank name": { ...valid, name: "   " },
    "a name of 61 characters": { ...valid, name: "x".repeat(61) },
    "an unknown style": { ...valid, style: "cider" },
    "a negative abv": { ...valid, abv: -0.1 },
    "an abv above 20": { ...valid, abv: 20.1 },
    "an unexpected detail": { ...valid, colour: "amber" },
  };
  assert.ok(invalid[problem], `no request is defined for a beer with ${problem}`);
  await this.call("POST", "/beers", invalid[problem]);
});

When("staff fetch {string}", async function (this: ApiWorld, name: string) {
  await this.call("GET", `/beers/${idOf(this, name)}`);
});

When("staff fetch the beer with id {string}", async function (this: ApiWorld, id: string) {
  await this.call("GET", `/beers/${id}`);
});

When("staff list the beers", async function (this: ApiWorld) {
  await this.call("GET", "/beers");
});

When("staff list the {word} beers", async function (this: ApiWorld, style: string) {
  await this.call("GET", `/beers?style=${style}`);
});

When("staff change the abv of {string} to {float}", async function (this: ApiWorld, name: string, abv: number) {
  await this.call("PATCH", `/beers/${idOf(this, name)}`, { abv });
});

When("staff rename {string} to {string}", async function (this: ApiWorld, name: string, newName: string) {
  await this.call("PATCH", `/beers/${idOf(this, name)}`, { name: newName });
});

When("staff send no changes for {string}", async function (this: ApiWorld, name: string) {
  await this.call("PATCH", `/beers/${idOf(this, name)}`, {});
});

When("staff retire {string}", async function (this: ApiWorld, name: string) {
  await this.call("DELETE", `/beers/${idOf(this, name)}`);
});

When(/^staff (fetch|change|retire|rate) a beer that is not in the catalogue$/, async function (this: ApiWorld, action: string) {
  const id = randomUUID();
  if (action === "fetch") await this.call("GET", `/beers/${id}`);
  if (action === "change") await this.call("PATCH", `/beers/${id}`, { abv: 5 });
  if (action === "retire") await this.call("DELETE", `/beers/${id}`);
  if (action === "rate") await this.call("POST", `/beers/${id}/ratings`, { score: 3 });
});

When(/^a drinker rates "([^"]*)" ([\d.]+)$/, async function (this: ApiWorld, name: string, score: string) {
  await rate(this, name, Number(score));
});

// --- Then -------------------------------------------------------------------

Then("the beer is added", function (this: ApiWorld) {
  expectStatus(this, 201);
});

Then("the beer is returned", function (this: ApiWorld) {
  expectStatus(this, 200);
});

Then("the beer is retired", function (this: ApiWorld) {
  expectStatus(this, 204);
});

Then("the rating is recorded", function (this: ApiWorld) {
  expectStatus(this, 201);
});

Then(/^the beer is named "([^"]*)", an? (\w+) at ([\d.]+)% abv$/, function (this: ApiWorld, name: string, style: string, abv: string) {
  const { name: actualName, style: actualStyle, abv: actualAbv } = this.last.body;
  assert.deepEqual({ name: actualName, style: actualStyle, abv: actualAbv }, { name, style, abv: Number(abv) });
});

Then("the beer has no ratings yet", function (this: ApiWorld) {
  assert.equal(this.last.body.rating_count, 0);
  assert.equal(this.last.body.average_rating, null);
});

Then(/^the beer has (\d+) ratings? averaging ([\d.]+)$/, function (this: ApiWorld, count: string, average: string) {
  assert.equal(this.last.body.rating_count, Number(count));
  assert.equal(this.last.body.average_rating, Number(average));
});

Then("{string} still has no ratings", async function (this: ApiWorld, name: string) {
  const { body } = await this.call("GET", `/beers/${idOf(this, name)}`);
  assert.equal(body.rating_count, 0);
  assert.equal(body.average_rating, null);
});

Then("the response says where to fetch the new beer", async function (this: ApiWorld) {
  const created = this.last.body;
  const location = this.last.headers.get("location");
  assert.ok(location, "the response has a Location header");
  const { status, body } = await this.call("GET", location);
  assert.equal(status, 200);
  assert.deepEqual(body, created);
});

Then("the list is empty", function (this: ApiWorld) {
  expectStatus(this, 200);
  assert.deepEqual(this.last.body.items, []);
});

Then("the list is, in order:", function (this: ApiWorld, table: DataTable) {
  expectStatus(this, 200);
  assert.deepEqual(
    this.last.body.items.map((beer: Json) => beer.name),
    table.raw().map((row) => row[0]),
  );
});

Then("the catalogue lists no beers", async function (this: ApiWorld) {
  const { status, body } = await this.call("GET", "/beers");
  assert.equal(status, 200);
  assert.deepEqual(body.items, []);
});

Then("{string} can no longer be fetched", async function (this: ApiWorld, name: string) {
  const { status } = await this.call("GET", `/beers/${idOf(this, name)}`);
  assert.equal(status, 404);
});

Then("the beer is not found", function (this: ApiWorld) {
  expectStatus(this, 404);
});

Then("the request is refused because the name is taken", function (this: ApiWorld) {
  expectStatus(this, 409);
});

Then("the request is refused as invalid", function (this: ApiWorld) {
  expectInvalid(this);
});

Then("the request is refused as invalid, pointing at {string}", function (this: ApiWorld, field: string) {
  expectInvalid(this, field);
});
