// The table itself is created by applying infra/ to AWS Emulator (see
// local/stack.mjs); this only empties it, between scenarios and before the fuzz run.
//   node local/table.ts reset
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, tableName } from "../src/lib/dynamo.ts";

/** Empty the table so every scenario starts from nothing. */
export async function resetTable(): Promise<void> {
  // Only ever an emulator's table: with no endpoint set this would be AWS itself, and a real table's data.
  if (!process.env.AWS_ENDPOINT_URL) throw new Error(`refusing to empty the table "${tableName}": AWS_ENDPOINT_URL is not set, so this is not an emulator. The scenarios and the fuzz run are for the local stack (task features, task contract:fuzz, task acceptance).`);
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
