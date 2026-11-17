// The table itself is created by applying infra/ to AWS Emulator (see
// local/stack.mjs); this only empties it, between scenarios and before the fuzz run.
//   node local/table.ts reset
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, tableName } from "../src/lib/dynamo.ts";

// Where AWS itself answers: every partition's DNS suffix, plain and dual-stack, as the SDK's partition data has them.
const AWS_SUFFIXES = [
  "amazonaws.com",
  "amazonaws.com.cn",
  "amazonaws.eu",
  "api.aws",
  "api.amazonwebservices.com.cn",
  "api.amazonwebservices.eu",
  "c2s.ic.gov",
  "api.aws.ic.gov",
  "sc2s.sgov.gov",
  "api.aws.scloud",
  "cloud.adc-e.uk",
  "api.cloud-aws.adc-e.uk",
  "csp.hci.ic.gov",
  "api.aws.hci.ic.gov",
];

/** True for a host that is AWS itself, however it is written - and for no host at all: only a named emulator is safe. */
export function isAws(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.+$/, "");
  return name === "" || AWS_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

/** The host a DynamoDB request from here would be sent to, as the SDK resolves it - nothing is sent. */
async function target(): Promise<string> {
  const probe = new DynamoDBClient({});
  let host = "";
  probe.middlewareStack.add(
    () => async (args) => {
      host = (args.request as { hostname?: string }).hostname ?? "";
      throw new Error("not sent");
    },
    { step: "build" },
  );
  await probe.send(new ListTablesCommand({})).catch(() => {});
  return host;
}

/** Empty the table so every scenario starts from nothing. */
export async function resetTable(): Promise<void> {
  // Only ever an emulator's table. Where the request would go is what counts,
  // however that was configured: at AWS itself this would be a real table's data.
  const host = await target();
  if (isAws(host)) {
    throw new Error(`refusing to empty the table "${tableName}": it would be sent to ${host || "an endpoint that could not be told"}, which is AWS itself, not an emulator. The scenarios and the fuzz run are for the local stack (task features, task contract:fuzz, task acceptance).`);
  }
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({ TableName: tableName, ProjectionExpression: "pk, sk", ConsistentRead: true, ExclusiveStartKey: start }),
    );
    const keys = page.Items ?? [];
    for (let i = 0; i < keys.length; i += 25) {
      await dynamo.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
        }),
      );
    }
    start = page.LastEvaluatedKey;
  } while (start);
}

if (process.argv[1]?.endsWith("table.ts") && process.argv[2] === "reset") await resetTable();
