import { expect, test } from "vitest";
import { asyncapiNameProblems, type Contract, datacontractNameProblems, deprecated, majorOf, openapiNameProblems, versionProblems } from "../scripts/contracts.ts";

const v1 = (kind: Contract["kind"]): Contract => ({ kind, path: `specs/${kind}.v1.yaml`, major: 1 });

test("a file holds one major: the one its name says", () => {
  expect(versionProblems(v1("openapi"), { info: { version: "1.4.2" } })).toEqual([]);
  expect(versionProblems(v1("datacontract"), { version: "1.0.0" })).toEqual([]);
  expect(versionProblems(v1("openapi"), { info: { version: "2.0.0" } })).toEqual([expect.stringContaining("it is specs/openapi.v2.yaml, or its version is 1.x.x")]);
  expect(versionProblems(v1("asyncapi"), { info: { version: "1.0" } })).toEqual([expect.stringContaining("not MAJOR.MINOR.PATCH")]);
  expect(majorOf("0.3.1")).toBe(0);
  expect(majorOf("01.0.0")).toBeUndefined();
});

test("an HTTP major's paths start /v<N> and its operationIds end _v<N>", () => {
  const good = { paths: { "/v1/beers": { get: { operationId: "list_beers_v1" } }, "/v1": { get: { operationId: "root_v1" } } } };
  expect(openapiNameProblems(v1("openapi"), good)).toEqual([]);
  const bad = { paths: { "/beers": { get: { operationId: "list_beers" } }, "/v10/beers": { post: { operationId: "create_beer_v1" } } } };
  expect(openapiNameProblems(v1("openapi"), bad)).toEqual([
    expect.stringContaining("path /beers does not start /v1/"),
    expect.stringContaining("operationId list_beers does not end _v1"),
    expect.stringContaining("path /v10/beers does not start /v1/"),
  ]);
});

test("an event's message and operations carry its type's version", () => {
  const created = { name: "beer_created_v2", type: "com.example.catalogue.beer.created.v2" };
  expect(asyncapiNameProblems("a.yaml", [{ id: "publish_beer_created_v2", messages: [created] }])).toEqual([]);
  expect(asyncapiNameProblems("a.yaml", [{ id: "publish_beer_created", messages: [{ ...created, name: "beer_created" }] }])).toEqual([
    expect.stringContaining("message beer_created has type com.example.catalogue.beer.created.v2, so its name ends _v2"),
    expect.stringContaining("operation publish_beer_created carries v2 messages, so its name ends _v2"),
  ]);
  const older = { name: "beer_created_v1", type: "com.example.catalogue.beer.created.v1" };
  expect(asyncapiNameProblems("a.yaml", [{ id: "publish_beer_created_v2", messages: [created, older] }])).toEqual([expect.stringContaining("carries messages of more than one version")]);
});

test("a data contract major's id and locations carry its major", () => {
  const good = { id: "beers-events-v1", servers: [{ server: "production", location: "s3://beers-events/events/v1/" }] };
  expect(datacontractNameProblems(v1("datacontract"), good)).toEqual([]);
  const bad = { id: "beers-events", servers: [{ server: "production", location: "s3://beers-events/events/" }] };
  expect(datacontractNameProblems(v1("datacontract"), bad)).toEqual([expect.stringContaining('id "beers-events" does not end -v1'), expect.stringContaining("does not end /v1/")]);
});

test("a major is deprecated as each kind of contract says", () => {
  expect(deprecated("openapi", { paths: { "/v1/a": { get: { deprecated: true }, post: { deprecated: true } } } })).toBe(true);
  expect(deprecated("openapi", { paths: { "/v1/a": { get: { deprecated: true }, post: {} } } })).toBe(false);
  expect(deprecated("openapi", { paths: {} })).toBe(false);
  expect(deprecated("asyncapi", { info: { "x-deprecated": true } })).toBe(true);
  expect(deprecated("datacontract", { status: "deprecated" })).toBe(true);
  expect(deprecated("datacontract", { status: "active" })).toBe(false);
});
