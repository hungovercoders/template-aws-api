import { createConsumer } from "./lib/consumer.ts";
import { consumers } from "./generated/consumers.ts";

export const handler = createConsumer(consumers);
