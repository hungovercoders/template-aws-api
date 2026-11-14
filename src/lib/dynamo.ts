import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// No endpoint or credentials here: on AWS the Lambda role supplies them, and
// locally AWS_ENDPOINT_URL (set by local/stack.mjs) points the SDK at AWS Emulator.
export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** The single table from infra/main.tf: string keys `pk` and `sk`. */
export const tableName = process.env.TABLE_NAME ?? "api-local";
