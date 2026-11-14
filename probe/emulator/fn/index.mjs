import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
const ddb = new DynamoDBClient({});
const eb = new EventBridgeClient({});
const put = (pk, extra = {}) => ddb.send(new PutItemCommand({ TableName: process.env.TABLE_NAME, Item: { pk: { S: pk }, sk: { S: "x" }, ...extra } }));

// SQS consumer: a body containing "fail" is reported as a failed item, the rest are recorded.
export async function consumer(event) {
  const batchItemFailures = [];
  for (const r of event.Records) {
    console.log(JSON.stringify({ fn: "consumer", id: r.messageId, body: r.body, receives: r.attributes?.ApproximateReceiveCount }));
    if (r.body.includes("fail")) batchItemFailures.push({ itemIdentifier: r.messageId });
    else await put(`consumed#${r.body}`);
  }
  return { batchItemFailures };
}

// Stream forwarder: outbox inserts become events on the bus.
export async function forwarder(event) {
  for (const r of event.Records) {
    const pk = r.dynamodb?.NewImage?.pk?.S ?? "";
    console.log(JSON.stringify({ fn: "forwarder", name: r.eventName, pk }));
    if (pk.includes("boom")) throw new Error("boom");
    if (r.eventName !== "INSERT" || !pk.startsWith("outbox#")) continue;
    const out = await eb.send(new PutEventsCommand({ Entries: [{ EventBusName: process.env.BUS_NAME, Source: "probe", DetailType: "probe.thing.happened.v1",
      Detail: JSON.stringify({ specversion: "1.0", id: pk, source: "/probe", type: "probe.thing.happened.v1", time: new Date().toISOString(), data: { n: 1 } }) }] }));
    console.log(JSON.stringify({ fn: "forwarder", failed: out.FailedEntryCount }));
  }
}

// EventBridge rule target.
export async function target(event) {
  console.log(JSON.stringify({ fn: "target", event }));
  await put(`target#${event.detail?.id ?? event.id}`);
}
