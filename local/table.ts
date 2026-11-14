// The table itself is created by applying infra/ to AWS Emulator (see
// local/stack.mjs); this only empties it between scenarios.
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, tableName } from "../src/lib/dynamo.ts";

/** Empty the table so every scenario starts from nothing. */
export async function resetTable(): Promise<void> {
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
