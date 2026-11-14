// What every scenario shares: an HTTP client for the API under test that
// holds each response to the contract. Add step definitions next to this file.
import { AfterAll, Before, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { matchRoute, validateResponse } from "../src/lib/contract.ts";

setDefaultTimeout(20_000);

export type Json = Record<string, any>;
export type Reply = { status: number; headers: Headers; body: any };

/** Every "operationId status" a scenario was answered with, for `task responses:check`. */
const answered = new Set<string>();

export class ApiWorld extends World {
  base = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  /** The most recent response, for Then steps to assert on. */
  last: Reply = { status: 0, headers: new Headers(), body: undefined };
  /** Who the next calls are made as; undefined calls anonymously. Only matters for operations the contract secures. */
  caller: string | undefined;
  /** Scenario-scoped memory for step definitions, e.g. records a Given step created, by name. */
  remembered = new Map<string, any>();

  /**
   * Call the API. The response must conform to the contract - a documented
   * status, content type and body schema for the operation - or the step
   * fails, whatever else it goes on to assert.
   */
  async call(method: string, path: string, body?: unknown): Promise<Reply> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // The local stack's stand-in for a signed token; see local/server.ts.
        ...(this.caller === undefined ? {} : { authorization: `Bearer test:${this.caller}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? undefined;
    const parsed = text === "" ? undefined : /json/.test(contentType ?? "") ? JSON.parse(text) : text;
    this.last = { status: res.status, headers: res.headers, body: parsed };

    const match = matchRoute(method, new URL(this.base + path).pathname);
    assert.ok(match, `${method} ${path} is not an operation in specs/openapi.yaml`);
    answered.add(`${match.operation.operationId} ${res.status}`);
    const violations = validateResponse(match.operation, res.status, contentType, parsed);
    assert.deepEqual(violations, [], `${method} ${path} broke the contract:\n  ${violations.join("\n  ")}\n  body: ${text}`);
    return this.last;
  }
}

setWorldConstructor(ApiWorld);

// Scenarios are independent: each starts from an empty table.
Before(async function (this: ApiWorld) {
  const res = await fetch(`${this.base}/__local/reset`, { method: "POST" });
  assert.equal(res.status, 204, "the local stack reset its data");
});

// What the scenarios were answered with, for the gate that holds the contract to it.
AfterAll(function () {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/responses-answered.json", JSON.stringify([...answered].sort(), null, 2) + "\n");
});
