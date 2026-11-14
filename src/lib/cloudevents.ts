// Every message this API receives and every event it publishes is a
// CloudEvent 1.0 in structured JSON mode, as specs/asyncapi.yaml describes it.
// The envelope is the skeleton's: an operation supplies what happened, to
// what, and the data; this sets the rest, and holds both directions to the
// contract so nothing leaves or enters that the contract does not describe.
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import generated from "../generated/asyncapi.json" with { type: "json" };
import { continueTrace, traceparent } from "./trace.ts";

export type CloudEvent<Type extends string = string, Data = unknown> = {
  specversion: "1.0";
  id: string;
  source: string;
  type: Type;
  time: string;
  subject?: string;
  datacontenttype?: string;
  dataschema?: string;
  traceparent?: string;
  data: Data;
};

export type EventViolation = { pointer: string; message: string };

/** A message that is not a CloudEvent this API's contract describes. It can never succeed, so it is not retried. */
export class InvalidEvent extends Error {
  constructor(
    readonly reason: string,
    readonly violations: EventViolation[] = [],
  ) {
    super(violations.length > 0 ? `${reason}: ${violations.map((v) => `${v.pointer || "/"} ${v.message}`).join("; ")}` : reason);
    this.name = "InvalidEvent";
  }
}

type Schema = Record<string, unknown> & { allOf?: Schema[]; properties?: Record<string, Schema>; const?: unknown };
type Message = { payload?: Schema };
// The contract as `task generate` wrote it: resolved, so every operation holds its messages.
type Document = { operations?: Record<string, { action?: string; messages?: Message[] }> };

// The `type` a payload fixes with a const, wherever allOf puts it.
function fixedType(schema: Schema | undefined): string | undefined {
  if (!schema) return undefined;
  const own = schema.properties?.type?.const;
  if (typeof own === "string") return own;
  for (const part of schema.allOf ?? []) {
    const found = fixedType(part);
    if (found) return found;
  }
  return undefined;
}

/** The events of one contract. `events` below is this API's; a test makes its own. */
export function eventsOf(document: Document, source = () => process.env.EVENT_SOURCE ?? "/local") {
  // What the contract says this API publishes (`send`) and accepts (`receive`), by type.
  const schemas = { send: new Map<string, Schema>(), receive: new Map<string, Schema>() };
  for (const operation of Object.values(document.operations ?? {})) {
    const direction = operation.action === "send" ? schemas.send : operation.action === "receive" ? schemas.receive : undefined;
    for (const message of operation.messages ?? []) {
      const type = fixedType(message.payload);
      if (direction && type && message.payload) direction.set(type, message.payload);
    }
  }
  // Compiled the first time a type is used, as the router compiles a request's schema.
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const compiled = new Map<Schema, ValidateFunction>();
  const validator = (schema: Schema) => compiled.get(schema) ?? compiled.set(schema, ajv.compile(schema)).get(schema)!;
  const violationsOf = (schema: Schema, event: unknown): EventViolation[] => {
    const validate = validator(schema);
    return validate(event) ? [] : (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, message: error.message ?? "is invalid" }));
  };

  return {
    /** The types this API publishes and the types it accepts. */
    publishes: [...schemas.send.keys()],
    accepts: [...schemas.receive.keys()],

    /**
     * An event to publish: `type`, `data` and what it happened to are yours;
     * id, source, time and the trace are set here. Throws if the result is not
     * what the contract says an event of that type is - in the operation,
     * where a scenario sees it, not after the write.
     */
    create<Event extends CloudEvent>(type: Event["type"], data: Event["data"], subject?: string): Event {
      const schema = schemas.send.get(type);
      if (!schema) throw new Error(`"${type}" is not an event specs/asyncapi.yaml says this API publishes; an event is added to the contract, as a send operation, before it is published`);
      const event = {
        specversion: "1.0",
        id: randomUUID(),
        source: source(),
        type,
        time: new Date().toISOString(),
        ...(subject === undefined ? {} : { subject }),
        datacontenttype: "application/json",
        traceparent: traceparent(),
        data,
      } as Event;
      const violations = violationsOf(schema, event);
      if (violations.length > 0) throw new Error(`the ${type} event does not match specs/asyncapi.yaml: ${violations.map((v) => `${v.pointer || "/"} ${v.message}`).join("; ")}`);
      return event;
    },

    /**
     * A message received: the CloudEvent it is, held to the contract for its
     * type. Throws InvalidEvent for anything else, before any of your code
     * runs. The trace the message carries becomes the one in force, so what
     * handling it logs and publishes belongs to the same trace.
     */
    parse(message: string | unknown): CloudEvent {
      let event: unknown = message;
      if (typeof message === "string") {
        try {
          event = JSON.parse(message);
        } catch {
          throw new InvalidEvent("the message is not JSON");
        }
      }
      const type = (event as { type?: unknown } | null)?.type;
      if (typeof type !== "string") throw new InvalidEvent("the message is not a CloudEvent: it has no type");
      const schema = schemas.receive.get(type);
      if (!schema) throw new InvalidEvent(`"${type}" is not a message this API's contract says it accepts`);
      const violations = violationsOf(schema, event);
      if (violations.length > 0) throw new InvalidEvent(`the ${type} message does not match the contract`, violations);
      continueTrace((event as CloudEvent).traceparent);
      return event as CloudEvent;
    },
  };
}

/** This API's events, from specs/asyncapi.yaml. */
export const events = eventsOf(generated as unknown as Document);
