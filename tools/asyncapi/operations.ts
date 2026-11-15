// What `task generate` wrote about the AsyncAPI contract, for the scripts
// that follow from its operations (scripts/consume.ts, scripts/publish.ts).
// They read it here, so they need no AsyncAPI tooling of their own.
import { existsSync, readFileSync } from "node:fs";

export type Operation = { id: string; action: string; address: string; messages: { name: string; type?: string }[] };
const TABLE = "src/generated/async-operations.ts";
const TYPES = "src/generated/messages.d.ts";

/** The contract's operations of one direction. The file is `export const asyncOperations = <JSON> as const;`. */
export function operations(action: "send" | "receive"): Operation[] {
  if (!existsSync(TABLE)) return [];
  const json = /export const asyncOperations = ([\s\S]*?) as const;/.exec(readFileSync(TABLE, "utf8"))?.[1];
  return (JSON.parse(json ?? "[]") as Operation[]).filter((operation) => operation.action === action);
}

const pascal = (name: string) =>
  name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

/** The generated type of a message's payload: named after the schema it came from when it has one, the message otherwise. */
export function payloadType(message: { name: string; type?: string }): string {
  const types = existsSync(TYPES) ? readFileSync(TYPES, "utf8") : "";
  const byType = message.type && new RegExp(`export interface (\\w+) \\{[^}]*'type': '${message.type.replace(/\./g, "\\.")}'`).exec(types)?.[1];
  return byType || pascal(message.name);
}
