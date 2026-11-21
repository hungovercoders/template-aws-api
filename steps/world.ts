// What every scenario shares: an HTTP client for the API under test - the
// built Lambda behind AWS Emulator's API Gateway - that holds each response
// to the contract. Add step definitions next to this file.
import { AfterAll, Before, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resetTable } from "../local/table.ts";
import { tokenFor } from "../local/token.ts";
import { matchRoute, validateResponse } from "../src/lib/contract.ts";

setDefaultTimeout(20_000);

export type Json = Record<string, any>;
export type Reply = { status: number; headers: Headers; body: any };

/** Every "operationId status" a scenario was answered with, for `task responses:check`. */
const answered = new Set<string>();

export class ApiWorld extends World {
  /** Set by local/stack.mjs: the API's endpoint on AWS Emulator. */
  base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
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
        ...(this.caller === undefined ? {} : { authorization: `Bearer ${tokenFor(this.caller)}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const contentType = res.headers.get("content-type") ?? undefined;
    const parsed = text === "" ? undefined : /json/.test(contentType ?? "") ? JSON.parse(text) : text;
    this.last = { status: res.status, headers: res.headers, body: parsed };

    const match = matchRoute(method, new URL(path, "http://api").pathname);
    assert.ok(match, `${method} ${path} is not an operation in any specs/openapi.v<N>.yaml`);
    answered.add(`${match.operation.operationId} ${res.status}`);
    const violations = validateResponse(match.operation, res.status, contentType, parsed);
    assert.deepEqual(violations, [], `${method} ${path} broke the contract:\n  ${violations.join("\n  ")}\n  body: ${text}`);
    return this.last;
  }

  /**
   * Call one operation faster than its contract's `x-rate-limit` allows - its burst and two
   * seconds' worth more, all at once - and count the answers by status. Every answer is held to
   * the contract, so a 429 must be documented. Then wait for the limit to refill, so the next
   * scenario is not refused for this one's haste. Use a cheap operation, a read.
   */
  async flood(method: string, path: string, body?: unknown): Promise<Record<number, number>> {
    const match = matchRoute(method, new URL(path, "http://api").pathname);
    const limit = match?.operation.rateLimit;
    assert.ok(limit, `${method} ${path} has no x-rate-limit in its contract to call faster than`);
    const replies = await Promise.all(Array.from({ length: limit.burst + 2 * limit.requests_per_second }, () => this.call(method, path, body)));
    const counts: Record<number, number> = {};
    for (const reply of replies) counts[reply.status] = (counts[reply.status] ?? 0) + 1;
    const refill = (limit.burst / limit.requests_per_second + 5) * 1000;
    await eventually(async () => assert.notEqual((await this.call(method, path, body)).status, 429, "the rate limit has not refilled"), { timeout: refill, every: 1000 });
    return counts;
  }
}

setWorldConstructor(ApiWorld);

/**
 * Wait for something that happens after the API has answered - a message
 * handled, an event published. The assertion is tried until it passes; when
 * time runs out its last failure is the step's failure. Never a sleep: a
 * scenario waits exactly as long as the API takes.
 */
export async function eventually<T>(assertion: () => Promise<T> | T, { timeout = 15_000, every = 200 } = {}): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await assertion();
    } catch (error) {
      if (Date.now() + every > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, every));
    }
  }
}

// Scenarios are independent: each starts from an empty table.
Before(async function (this: ApiWorld) {
  assert.ok(this.base, "BASE_URL is not set - run the scenarios with `task features`, which brings up the stack");
  await resetTable();
});

// What the scenarios were answered with, for the gate that holds the contract to it.
AfterAll(function () {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/responses-answered.json", JSON.stringify([...answered].sort(), null, 2) + "\n");
});
