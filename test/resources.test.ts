// How `task resources` shows a stack (local/resources.ts).
import { expect, test } from "vitest";
import { arnsOf, partsOf, render } from "../local/resources.ts";

test("an ARN is its service and the resource as that service names it", () => {
  expect(partsOf("arn:aws:dynamodb:eu-west-2:123456789012:table/beer-catalogue")).toEqual({ service: "dynamodb", resource: "table/beer-catalogue" });
  expect(partsOf("arn:aws:lambda:eu-west-2:123456789012:function:beer-catalogue")).toEqual({ service: "lambda", resource: "function:beer-catalogue" });
  expect(partsOf("arn:aws:s3:::beer-catalogue-events")).toEqual({ service: "s3", resource: "beer-catalogue-events" });
});

test("resources are listed under their service, services and resources in order", () => {
  const text = render(["arn:aws:sqs:eu-west-2:1:b-queue", "arn:aws:dynamodb:eu-west-2:1:table/b", "arn:aws:sqs:eu-west-2:1:a-queue"]);
  expect(text).toBe("dynamodb (1)\n  table/b\nsqs (2)\n  a-queue\n  b-queue");
});

test("a resource is listed once, and a setting without an ARN of its own is not listed apart", () => {
  const state = {
    resources: [
      { mode: "managed", instances: [{ attributes: { arn: "arn:aws:sns:eu-west-2:1:alarms" } }] },
      { mode: "managed", instances: [{ attributes: { arn: "arn:aws:sns:eu-west-2:1:alarms" } }] }, // its topic policy
      { mode: "managed", instances: [{ attributes: { id: "lambda-permission" } }] },
      { mode: "data", instances: [{ attributes: { arn: "arn:aws:iam::1:role/someone-elses" } }] },
    ],
  };
  expect(arnsOf(state)).toEqual(["arn:aws:sns:eu-west-2:1:alarms"]);
});
