// The local twin of the DynamoDB table in infra/main.tf. Keep the two in step.
import { CreateTableCommand, DescribeTableCommand, ResourceNotFoundException, waitUntilTableExists } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { dynamo, tableName } from "../src/lib/dynamo.ts";

export async function ensureTable(): Promise<void> {
  try {
    await dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  await dynamo.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
  await waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: tableName });
}

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
