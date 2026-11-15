// The events the API publishes, from the command line.
//   node local/events.ts tail [type]     - follow the events as they are published; all of them, or one type
//   node local/events.ts outbox          - the events written but not yet on the bus
//   node local/events.ts unpublished     - the events that could not be published, and why
//   node local/events.ts retry           - publish those again, and take each off the list once it is on the bus;
//                                          also what has waited in the outbox longer than the forwarder would leave it
// ENV=local (the default) is the stack `task dev` keeps up; ENV=aws is the
// deployed stack, with your AWS credentials.
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { busEntry } from "../src/lib/outbox.ts";
import { stackOutputs } from "./outputs.ts";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const { table_name: table, event_bus_name: busName, event_log_group: logGroup, unpublished_queue_url: unpublished } = stackOutputs("events");
if (!table || !busName || !unpublished) fail("events: the stack publishes no events");
// Through the configured endpoint, not the host in the queue's URL: AWS Emulator gives its queues URLs that name AWS itself.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

type Event = { id?: string; type?: string; source?: string; time?: string; subject?: string; data?: unknown };
const show = (event: Event) => console.log(`${event.time ?? ""}  ${event.type ?? "(no type)"}${event.subject ? `  ${event.subject}` : ""}\n${JSON.stringify(event.data ?? event, null, 2)}\n`);

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bus = new EventBridgeClient({});
// Long after the forwarder would have published it, were it going to.
const STUCK_MS = 5 * 60_000;

type Written = { pk: string; sk: string; event?: Event; written_at?: string };
/** Every event in the outbox, oldest first. */
async function written(): Promise<Written[]> {
  const waiting: Written[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dynamo.send(new ScanCommand({ TableName: table, FilterExpression: "begins_with(pk, :outbox)", ExpressionAttributeValues: { ":outbox": "outbox#" }, ConsistentRead: true, ExclusiveStartKey: start }));
    waiting.push(...((page.Items ?? []) as Written[]));
    start = page.LastEvaluatedKey;
  } while (start);
  return waiting.sort((a, b) => (a.written_at ?? "").localeCompare(b.written_at ?? ""));
}

/** Put an event on the bus as the forwarder would. Returns why not, if the bus refused it. */
async function put(event: Event): Promise<string | undefined> {
  const result = await bus.send(new PutEventsCommand({ Entries: [busEntry(event as { source: string; type: string }, busName)] }));
  const refused = result.Entries?.find((entry) => entry.ErrorCode);
  return refused ? [refused.ErrorCode, refused.ErrorMessage].filter(Boolean).join(" ") : undefined;
}

const [command, wanted] = process.argv.slice(2);
if (command === "tail") {
  if (!logGroup) fail("events: the stack keeps no log of its events (event_log_days is 0), so there is nothing to follow");
  const logs = new CloudWatchLogsClient({});
  const shown = new Set<string>();
  console.log(`following ${wanted ?? "every event"} on ${busName} - Ctrl-C to stop\n`);
  // From a minute ago, then whatever is new, every second.
  for (let since = Date.now() - 60_000; ; ) {
    let next: string | undefined;
    // A page's token is only good for the request it came from, so one sweep reads from one time.
    const from = since;
    do {
      const page = await logs.send(new FilterLogEventsCommand({ logGroupName: logGroup, startTime: from, nextToken: next }));
      for (const line of page.events ?? []) {
        if (shown.has(line.eventId ?? "")) continue;
        shown.add(line.eventId ?? "");
        since = Math.max(since, line.timestamp ?? since);
        const event = (JSON.parse(line.message ?? "{}") as { detail?: Event }).detail ?? {};
        if (!wanted || event.type === wanted) show(event);
      }
      next = page.nextToken;
    } while (next);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} else if (command === "outbox") {
  const waiting = await written();
  console.log(`${waiting.length} events written and not yet on the bus${waiting.length > 0 ? ":" : " - the forwarder is up to date"}\n`);
  for (const item of waiting) show(item.event ?? {});
} else if (command === "unpublished" || command === "retry") {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: unpublished!, AttributeNames: ["ApproximateNumberOfMessages"] }));
  console.log(`about ${Attributes?.ApproximateNumberOfMessages ?? "?"} events could not be published\n`);
  const seen = new Set<string>();
  // A read is a sample of the queue, and may repeat one: stop only when several in a row bring nothing new.
  for (let reads = 0, nothingNew = 0; reads < 200 && nothingNew < 3; reads++) {
    // Looking hides nothing. Retrying holds each for a minute, so a second run does not send it twice.
    const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: unpublished!, MaxNumberOfMessages: 10, VisibilityTimeout: command === "retry" ? 60 : 0, WaitTimeSeconds: 1, MessageAttributeNames: ["All"] }));
    const fresh = (page.Messages ?? []).filter((message) => !seen.has(message.MessageId ?? ""));
    nothingNew = fresh.length === 0 ? nothingNew + 1 : 0;
    for (const message of fresh) {
      seen.add(message.MessageId ?? "");
      const event = JSON.parse(message.Body ?? "{}") as Event;
      if (command === "unpublished") {
        console.log(`why: ${message.MessageAttributes?.reason?.StringValue ?? "no reason was recorded"}`);
        show(event);
        continue;
      }
      if (!event.type || !event.source) {
        console.log(`left where it is - it is not an event that can be published: ${message.Body?.slice(0, 200)}`);
        continue;
      }
      const refused = await put(event);
      if (refused) {
        console.log(`still refused, left where it is: ${event.type} ${event.id} - ${refused}`);
        continue;
      }
      await sqs.send(new DeleteMessageCommand({ QueueUrl: unpublished!, ReceiptHandle: message.ReceiptHandle }));
      console.log(`published ${event.type} ${event.id}`);
    }
  }
  if (command === "retry") {
    // What the forwarder never dealt with: written long enough ago that it is not about to.
    const stuck = (await written()).filter((item) => Date.parse(item.written_at ?? "") < Date.now() - STUCK_MS);
    if (stuck.length > 0) console.log(`\n${stuck.length} events have waited in the outbox for more than ${STUCK_MS / 60_000} minutes; publishing them`);
    for (const { pk, sk, event } of stuck) {
      if (!event?.type || !event.source) {
        console.log(`left where it is - it is not an event that can be published: ${pk}`);
        continue;
      }
      const refused = await put(event);
      if (refused) {
        console.log(`refused, left where it is: ${event.type} ${event.id} - ${refused}`);
        continue;
      }
      await dynamo.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
      console.log(`published ${event.type} ${event.id}`);
    }
  }
} else fail("events: tail [type] | outbox | unpublished | retry");
