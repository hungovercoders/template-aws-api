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
  assert.ok(this.base, "BASE_URL is not set - run the scenarios with `task features`, which brings up the stack");
  await resetTable();
});

// What the scenarios were answered with, for the gate that holds the contract to it.
AfterAll(function () {
  mkdirSync(".local", { recursive: true });
  writeFileSync(".local/responses-answered.json", JSON.stringify([...answered].sort(), null, 2) + "\n");
});
