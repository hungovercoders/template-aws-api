// The W3C trace context of what is being handled: one trace id from the
// request or message that started the work, through every log line, to
// every event the work publishes. https://www.w3.org/TR/trace-context/
import { randomBytes } from "node:crypto";

const FORMAT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
let current: string | undefined;

/**
 * Start handling something. An incoming `traceparent` that is well formed
 * carries its trace on, with a span of this API's own; anything else starts a
 * new trace. Returns the traceparent now in force.
 */
export function continueTrace(incoming?: string): string {
  const [, trace, , flags] = FORMAT.exec(incoming?.trim().toLowerCase() ?? "") ?? [];
  const known = trace && !/^0+$/.test(trace);
  current = `00-${known ? trace : randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-${known ? flags : "01"}`;
  return current;
}

/** The traceparent in force, starting a trace if nothing has. */
export const traceparent = (): string => current ?? continueTrace();

/** Its trace id - what a log line carries, and what to search the logs for. */
export const traceId = (): string => traceparent().split("-")[1]!;
