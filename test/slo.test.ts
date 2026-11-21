// Which SLOs (specs/slos) the alarms can act on (scripts/slo.ts); oslo says they are valid OpenSLO.
import { expect, test } from "vitest";
import { type Slo, shapeOf, sloProblems } from "../scripts/slo.ts";

const source = (metricName: string, stat = "Sum") => ({ metricSource: { type: "CloudWatch", spec: { namespace: "AWS/ApiGateway", metricName, stat } } });
const availability = (name = "availability", target = 0.999): Slo => ({
  metadata: { name },
  spec: { indicator: { spec: { ratioMetric: { counter: true, bad: source("5xx"), total: source("Count") } } }, objectives: [{ target }] },
});
const latency = (name: string, operation?: string, stat = "p99", value = 500): Slo => ({
  metadata: { name, ...(operation ? { labels: { operation } } : {}) },
  spec: { indicator: { spec: { thresholdMetric: source("Latency", stat) } }, objectives: [{ op: "lte", value, target: 0.99 }] },
});
const file = (slo: Slo) => ({ path: `specs/slos/${slo.metadata!.name}.yaml`, slo });

test("availability is the share of requests answered 5xx; latency a percentile, for the API or one operation", () => {
  expect(shapeOf(availability())).toEqual({ kind: "availability", target: 0.999 });
  expect(shapeOf(latency("api-latency", undefined, "p95", 800))).toEqual({ kind: "latency", stat: "p95", milliseconds: 800 });
  expect(shapeOf(latency("list", "list_things_v1"))).toEqual({ kind: "latency", stat: "p99", milliseconds: 500, operation: "list_things_v1" });
});

test("an SLO the alarms cannot measure is refused with what to change", () => {
  const lambda: Slo = { ...latency("x"), spec: { ...latency("x").spec, indicator: { spec: { thresholdMetric: { metricSource: { type: "CloudWatch", spec: { namespace: "AWS/Lambda", metricName: "Duration", stat: "p99" } } } } } } };
  expect(shapeOf(lambda)).toContain("is neither shape");
  expect(shapeOf(latency("x", undefined, "Average"))).toContain("the template reads a percentile");
  expect(shapeOf({ ...latency("x"), spec: { ...latency("x").spec, objectives: [{ op: "gte", value: 500, target: 0.99 }] } })).toContain("op: lte");
  expect(shapeOf({ ...availability(), spec: { ...availability().spec, objectives: [{ target: 0.99 }, { target: 0.999 }] } })).toContain("more than one objective");
  expect(shapeOf({ ...availability(), metadata: { name: "a", labels: { operation: "list_things_v1" } } })).toContain("drop its operation label");
});

test("the SLOs agree with each other and with the contract", () => {
  const operations = ["list_things_v1"];
  expect(sloProblems([file(availability()), file(latency("api")), file(latency("list", "list_things_v1"))], operations)).toEqual([]);
  expect(sloProblems([file(latency("gone", "list_gone_v1"))], operations)).toEqual([expect.stringContaining("not an operationId")]);
  expect(sloProblems([file(availability("a")), file(availability("b"))], operations)).toEqual([expect.stringContaining("more than one availability SLO")]);
  expect(sloProblems([file(latency("a")), file(latency("b"))], operations)).toEqual([expect.stringContaining("more than one latency SLO for the whole API")]);
  expect(sloProblems([file(latency("a", "list_things_v1")), file(latency("b", "list_things_v1"))], operations)).toEqual([expect.stringContaining("for list_things_v1")]);
  expect(sloProblems([{ path: "specs/slos/other.yaml", slo: availability() }], operations)).toEqual([expect.stringContaining("name the file after its SLO")]);
});
