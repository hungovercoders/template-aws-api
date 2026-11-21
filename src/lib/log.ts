// One JSON object per line, in OpenTelemetry's log data model
// (https://opentelemetry.io/docs/specs/otel/logs/data-model/), which CloudWatch Logs
// Insights queries and any OpenTelemetry pipeline reads as it is:
//   Timestamp, SeverityText, SeverityNumber, Body, TraceId, SpanId, TraceFlags,
//   Resource (what wrote it) and Attributes (everything else about this line).
// TraceId and SpanId are the W3C trace context in force (trace.ts), so a request's
// lines, its messages' and the events it published share one trace.
// LOG_LEVEL (debug, info, warn, error; default info) sets what is written.
import { traceparent } from "./trace.ts";

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];
// The data model's severity numbers: DEBUG 5, INFO 9, WARN 13, ERROR 17.
const SEVERITY: Record<Level, number> = { debug: 5, info: 9, warn: 13, error: 17 };

export type Logger = Record<Level, (message: string, fields?: Record<string, unknown>) => void>;

function threshold(): number {
  const index = LEVELS.indexOf((process.env.LOG_LEVEL ?? "info").toLowerCase() as Level);
  return index === -1 ? LEVELS.indexOf("info") : index;
}

function describe(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

/** What wrote the line, in OpenTelemetry's semantic conventions; the same for every line of a function. */
function resource(): Record<string, string> {
  const entries: [string, string | undefined][] = [
    ["service.name", process.env.OTEL_SERVICE_NAME ?? process.env.AWS_LAMBDA_FUNCTION_NAME],
    ["cloud.provider", process.env.AWS_LAMBDA_FUNCTION_NAME ? "aws" : undefined],
    ["cloud.platform", process.env.AWS_LAMBDA_FUNCTION_NAME ? "aws_lambda" : undefined],
    ["cloud.region", process.env.AWS_REGION],
    ["faas.name", process.env.AWS_LAMBDA_FUNCTION_NAME],
    ["faas.version", process.env.AWS_LAMBDA_FUNCTION_VERSION],
  ];
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * A logger whose every line carries `base` among its Attributes - for a request, its id and
 * operation. Its lines are in the trace in force, or in `within`, a traceparent of their own:
 * the forwarder logs each event in the trace the event carries.
 */
export function createLogger(base: Record<string, unknown> = {}, within?: string): Logger {
  const write = (level: Level) => (message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS.indexOf(level) < threshold()) return;
    const [, trace, span, flags] = (within ?? traceparent()).split("-");
    const line = {
      Timestamp: new Date().toISOString(),
      SeverityText: level.toUpperCase(),
      SeverityNumber: SEVERITY[level],
      Body: message,
      TraceId: trace,
      SpanId: span,
      TraceFlags: flags,
      Resource: resource(),
      Attributes: { ...base, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, describe(v)])) },
    };
    (level === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}
