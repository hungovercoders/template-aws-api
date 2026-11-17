// The table reset (local/table.ts) empties a table. It may only ever be an
// emulator's: this is what it takes for AWS itself.
import { expect, test } from "vitest";
import { isAws } from "../local/table.ts";

test("AWS itself is recognised in every partition, however the host is written", () => {
  for (const host of [
    "dynamodb.eu-west-2.amazonaws.com",
    "dynamodb.eu-west-2.amazonaws.com.", // a fully qualified name
    "DynamoDB.EU-West-2.AmazonAWS.com",
    "vpce-0abc.dynamodb.eu-west-2.vpce.amazonaws.com",
    "dynamodb.eu-west-2.api.aws",
    "dynamodb.cn-north-1.amazonaws.com.cn",
    "dynamodb.cn-north-1.api.amazonwebservices.com.cn",
    "dynamodb.eusc-de-east-1.amazonaws.eu",
    "dynamodb.us-iso-east-1.c2s.ic.gov",
    "dynamodb.us-isob-east-1.sc2s.sgov.gov",
    "dynamodb.eu-isoe-west-1.cloud.adc-e.uk",
    "dynamodb.us-isof-south-1.csp.hci.ic.gov",
    // Nowhere that could be told is not an emulator either.
    "",
  ]) {
    expect(isAws(host), host).toBe(true);
  }
});

test("an emulator is not AWS, wherever it runs", () => {
  for (const host of ["127.0.0.1", "localhost", "host.docker.internal", "emulator.internal", "notamazonaws.com", "amazonaws.com.example.org"]) {
    expect(isAws(host), host).toBe(false);
  }
});
