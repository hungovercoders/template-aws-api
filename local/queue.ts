// The API's queue and its dead-letter queue, from the command line.
//   node local/queue.ts send <message> [file]   - send messages/<message>.json (or a file of your own) to the queue
//   node local/queue.ts peek                    - how many messages are waiting and being handled
//   node local/queue.ts dead-letters            - what is on the dead-letter queue, and why
//   node local/queue.ts redrive                 - move the dead-letter queue's messages back to the queue
// ENV=local (the default) is the stack `task dev` keeps up; ENV=aws is the
// deployed stack, with your AWS credentials.
import { GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient, StartMessageMoveTaskCommand } from "@aws-sdk/client-sqs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

type Outputs = { queue_url?: string; queue_arn?: string; dead_letter_queue_url?: string };
function outputs(): Outputs {
  if ((process.env.ENV ?? "local") === "aws") {
    const run = spawnSync("terraform", ["-chdir=infra", "output", "-json"], { encoding: "utf8" });
    if (run.status !== 0) fail(`queue: could not read the deployed stack's outputs\n${run.stderr.trim()}`);
    return Object.fromEntries(Object.entries(JSON.parse(run.stdout) as Record<string, { value: string }>).map(([name, output]) => [name, output.value]));
  }
  if (!existsSync(".local/stack.json")) fail("queue: the local stack is not up. Run `task dev` in another terminal, or use ENV=aws for the deployed stack.");
  const stack = JSON.parse(readFileSync(".local/stack.json", "utf8")) as { env?: Record<string, string>; outputs?: Outputs };
  const emulator = stack.env ?? {};
  // The local stack is on an emulator. Never let a request meant for it go to
  // AWS: without an endpoint to send to, stop.
  if (!emulator.AWS_ENDPOINT_URL && !process.env.AWS_ENDPOINT_URL) {
    fail("queue: `task dev` was started against an emulator of your own (AWS_ENDPOINT_URL). Set the same AWS_ENDPOINT_URL here, with its credentials and certificate.");
  }
  // Its endpoint, credentials and certificate. Node reads the certificate when
  // it starts, so this starts again with the stack's settings in place.
  if (emulator.AWS_ENDPOINT_URL && process.env.NODE_EXTRA_CA_CERTS !== emulator.NODE_EXTRA_CA_CERTS) {
    const env = { ...process.env, ...emulator };
    // Real credentials must never sign requests while the emulator is the target.
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
    const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env });
    process.exit(again.status ?? 1);
  }
  return stack.outputs ?? {};
}

const { queue_url: queue, queue_arn: queueArn, dead_letter_queue_url: deadLetterQueue } = outputs();
if (!queue || !queueArn || !deadLetterQueue) fail("queue: the stack has no queue; it has no async input");
// Through the configured endpoint, not the host in the queue's URL: AWS Emulator gives its queues URLs that name AWS itself.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

async function counts(url: string, what: string): Promise<void> {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
  console.log(`${what}: about ${Attributes?.ApproximateNumberOfMessages ?? "?"} waiting, ${Attributes?.ApproximateNumberOfMessagesNotVisible ?? "?"} being handled`);
}

const [command, name, given] = process.argv.slice(2);
if (command === "send") {
  const file = given ?? `messages/${name}.json`;
  if (!name || !existsSync(file)) fail("queue: say which message - one of messages/*.json by name (task asyncapi:examples writes them), or a name and a file of your own");
  const event = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  // An example is one event; sent again it would be a duplicate, and ignored.
  const body = JSON.stringify(given ? event : { ...event, id: randomUUID(), time: new Date().toISOString() });
  // A FIFO queue wants to know which messages are ordered together.
  const fifo = queue!.endsWith(".fifo") ? { MessageGroupId: String(event.source ?? "queue-send"), MessageDeduplicationId: randomUUID() } : {};
  const sent = await sqs.send(new SendMessageCommand({ QueueUrl: queue!, MessageBody: body, ...fifo }));
  console.log(`sent ${file} as message ${sent.MessageId}`);
} else if (command === "peek") {
  // Counts only. Reading a message to show it would count as one of its
  // tries, and enough looks would send it to the dead-letter queue untried.
  await counts(queue!, "queue");
  await counts(deadLetterQueue!, "dead-letter queue");
} else if (command === "dead-letters") {
  await counts(deadLetterQueue!, "dead-letter queue");
  // Nothing is hidden or taken, and nothing consumes this queue, so reading it costs a message nothing.
  const seen = new Set<string>();
  for (let reads = 0; reads < 20; reads++) {
    const page = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: deadLetterQueue!, MaxNumberOfMessages: 10, VisibilityTimeout: 0, WaitTimeSeconds: 1, MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["SentTimestamp"] }),
    );
    const fresh = (page.Messages ?? []).filter((message) => !seen.has(message.MessageId ?? ""));
    if (fresh.length === 0) break;
    for (const message of fresh) {
      seen.add(message.MessageId ?? "");
      const reason = message.MessageAttributes?.reason?.StringValue;
      console.log(`\n--- put aside ${new Date(Number(message.Attributes?.SentTimestamp)).toISOString()}\n    why: ${reason ?? "it failed every time it was offered (no reason was recorded)"}`);
      try {
        console.log(JSON.stringify(JSON.parse(message.Body ?? ""), null, 2));
      } catch {
        console.log(message.Body);
      }
    }
  }
} else if (command === "redrive") {
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterQueue!, AttributeNames: ["QueueArn", "ApproximateNumberOfMessages"] }));
  // To the queue by name: a message the consumer put aside itself has no record of where it came from.
  await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: Attributes?.QueueArn, DestinationArn: queueArn }));
  console.log(`moving about ${Attributes?.ApproximateNumberOfMessages ?? "?"} messages from the dead-letter queue back to the queue; they are handled again as they arrive`);
} else fail("queue: send <message> [file] | peek | dead-letters | redrive");
