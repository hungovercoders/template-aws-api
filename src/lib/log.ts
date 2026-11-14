// One JSON object per line, which is what CloudWatch Logs Insights queries.
// LOG_LEVEL (debug, info, warn, error; default info) sets what is written.
const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export type Logger = Record<Level, (message: string, fields?: Record<string, unknown>) => void>;

function threshold(): number {
  const index = LEVELS.indexOf((process.env.LOG_LEVEL ?? "info").toLowerCase() as Level);
  return index === -1 ? LEVELS.indexOf("info") : index;
}

function describe(value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
}

/** A logger whose every line carries `base` - for a request, its id and operation. */
export function createLogger(base: Record<string, unknown> = {}): Logger {
  const write = (level: Level) => (message: string, fields: Record<string, unknown> = {}) => {
    if (LEVELS.indexOf(level) < threshold()) return;
    const line = { level, message, ...base, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, describe(v)])) };
    (level === "error" ? console.error : console.log)(JSON.stringify(line));
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}
