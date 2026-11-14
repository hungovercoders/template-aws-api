// The API's queue and its dead-letter queue, from the command line.
//   node local/queue.ts send <message> [file]   - send messages/<message>.json (or a file of your own) to the queue
//   node local/queue.ts peek                    - what is waiting on the queue, without taking it
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

type Outputs = { queue_url?: string; dead_letter_queue_url?: string };
function outputs(): Outputs {
  if ((process.env.ENV ?? "local") === "aws") {
    const run = spawnSync("terraform", ["-chdir=infra", "output", "-json"], { encoding: "utf8" });
    if (run.status !== 0) fail(`queue: could not read the deployed stack's outputs\n${run.stderr.trim()}`);
    return Object.fromEntries(Object.entries(JSON.parse(run.stdout) as Record<string, { value: string }>).map(([name, output]) => [name, output.value]));
  }
  if (!existsSync(".local/stack.json")) fail("queue: the local stack is not up. Run `task dev` in another terminal, or use ENV=aws for the deployed stack.");
  const stack = JSON.parse(readFileSync(".local/stack.json", "utf8")) as { env?: Record<string, string>; outputs?: Outputs };
  // Point the SDK at the emulator the stack is on, with its credentials and
  // its certificate. Node reads the certificate when it starts, so this
  // starts again with the stack's settings in place.
  if (stack.env && process.env.NODE_EXTRA_CA_CERTS !== stack.env.NODE_EXTRA_CA_CERTS) {
    const env = { ...process.env, ...stack.env };
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete env[name];
    const again = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env });
    process.exit(again.status ?? 1);
  }
  return stack.outputs ?? {};
}

const { queue_url: queue, dead_letter_queue_url: deadLetterQueue } = outputs();
if (!queue || !deadLetterQueue) fail("queue: the stack has no queue; it has no async input");
// Through the configured endpoint, not the host in the queue's URL: AWS Emulator gives its queues URLs that name AWS itself.
const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

async function peek(url: string, what: string): Promise<void> {
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
  console.log(`${what}: about ${attributes.Attributes?.ApproximateNumberOfMessages ?? "?"} waiting, ${attributes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? "?"} being handled`);
  // Hidden for a second only, so nothing is taken from whoever is consuming.
  const page = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, VisibilityTimeout: 1, WaitTimeSeconds: 1, MessageAttributeNames: ["All"], MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"] }));
  for (const message of page.Messages ?? []) {
    const reason = message.MessageAttributes?.reason?.StringValue;
    console.log(`\n--- sent ${new Date(Number(message.Attributes?.SentTimestamp)).toISOString()}, received ${message.Attributes?.ApproximateReceiveCount} times${reason ? `\n    why: ${reason}` : ""}`);
    try {
      console.log(JSON.stringify(JSON.parse(message.Body ?? ""), null, 2));
    } catch {
      console.log(message.Body);
    }
  }
}

const [command, name, given] = process.argv.slice(2);
if (command === "send") {
  const file = given ?? `messages/${name}.json`;
  if (!name || !existsSync(file)) fail(`queue: say which message - one of messages/*.json by name (task asyncapi:examples writes them), or a name and a file of your own`);
  const event = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  // An example is one event; sent again it would be a duplicate, and ignored.
  const body = JSON.stringify(given ? event : { ...event, id: randomUUID(), time: new Date().toISOString() });
  const sent = await sqs.send(new SendMessageCommand({ QueueUrl: queue!, MessageBody: body }));
  console.log(`sent ${file} as message ${sent.MessageId}`);
} else if (command === "peek") await peek(queue!, "queue");
else if (command === "dead-letters") await peek(deadLetterQueue!, "dead-letter queue");
else if (command === "redrive") {
  const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: deadLetterQueue!, AttributeNames: ["QueueArn", "ApproximateNumberOfMessages"] }));
  await sqs.send(new StartMessageMoveTaskCommand({ SourceArn: attributes.Attributes?.QueueArn }));
  console.log(`moving about ${attributes.Attributes?.ApproximateNumberOfMessages ?? "?"} messages from the dead-letter queue back to the queue; they are handled again as they arrive`);
} else fail("queue: send <message> [file] | peek | dead-letters | redrive");
