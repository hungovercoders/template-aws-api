// The W3C trace context of what is being handled: one trace id from the
// request or message that started the work, through every log line, to
// every event the work publishes. https://www.w3.org/TR/trace-context/
import { randomBytes } from "node:crypto";

// version-traceid-parentid-flags, lower case hex. A later version may add
// fields after the flags; the first four are read the same way.
const FORMAT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
let current: string | undefined;

/**
 * Start handling something. An incoming `traceparent` that is valid carries
 * its trace on, with a span of this API's own; anything else starts a new
 * trace. Returns the traceparent now in force. Call it once for each request
 * or message: a function instance handles one at a time.
 */
export function continueTrace(incoming?: string): string {
  const [, version, trace, parent, flags, more] = FORMAT.exec(incoming?.trim() ?? "") ?? [];
  const valid = version !== undefined && version !== "ff" && !(version === "00" && more) && !/^0+$/.test(trace!) && !/^0+$/.test(parent!);
  current = `00-${valid ? trace : randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-${valid ? flags : "01"}`;
  return current;
}

/** The traceparent in force, starting a trace if nothing has. */
export const traceparent = (): string => current ?? continueTrace();

/** Its trace id - what a log line carries, and what to search the logs for. */
export const traceId = (): string => traceparent().split("-")[1]!;
