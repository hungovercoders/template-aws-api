// Routes API Gateway HTTP API events to operations by operationId, and holds
// every request to the contract before an operation sees it.
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { operations } from "../generated/api.d.ts";
import { operationForRouteKey, validateRequest } from "./contract.ts";
import { createLogger, type Logger } from "./log.ts";
import { continueTrace, traceId } from "./trace.ts";
import { HttpProblem, problem, unauthorized, type Result } from "./problem.ts";

type OperationId = keyof operations;
type Parameters<K extends OperationId, W extends "path" | "query"> = operations[K] extends { parameters: { [P in W]?: infer V } }
  ? NonNullable<V>
  : Record<string, never>;
type Body<K extends OperationId> = operations[K] extends { requestBody?: { content: { "application/json": infer B } } } ? B : undefined;

/** Who is calling, from the token API Gateway verified. */
export type Caller = { subject: string; claims: Record<string, unknown> };

function callerOf(event: APIGatewayProxyEventV2): Caller | undefined {
  const claims = (event.requestContext as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } } | undefined)?.authorizer?.jwt?.claims;
  return claims && typeof claims.sub === "string" ? { subject: claims.sub, claims } : undefined;
}

/** A request that has already passed contract validation. */
export type Context<K extends OperationId> = {
  path: Parameters<K, "path">;
  query: Parameters<K, "query">;
  body: Body<K>;
  event: APIGatewayProxyEventV2;
  /** Always present for operations the contract secures; undefined otherwise. */
  caller: Caller | undefined;
  /** Writes structured lines that carry this request's id and operation. */
  log: Logger;
};

export type Routes = { [K in OperationId]?: (context: Context<K>) => Promise<Result> };

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (event.body === undefined || event.body === "") return undefined;
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  return JSON.parse(text);
}

export function createHandler(routes: Routes): APIGatewayProxyHandlerV2 {
  const handlers = routes as Record<string, ((context: Context<never>) => Promise<Result>) | undefined>;
  // Every request is logged once, with the same fields, whatever handled it.
  return async (event) => {
    const started = Date.now();
    // The caller's trace carries on through this request's logs and anything it publishes.
    continueTrace(event.headers?.traceparent);
    const log = createLogger({
      request_id: event.requestContext?.requestId,
      trace_id: traceId(),
      route_key: event.routeKey,
      operation_id: operationForRouteKey(event.routeKey)?.operationId,
    });
    const result = await respond(event, log);
    // Every answer from an operation says which version of which contract produced it.
    const apiVersion = operationForRouteKey(event.routeKey)?.version;
    log.info("request", { status: result.statusCode, duration_ms: Date.now() - started, api_version: apiVersion });
    return apiVersion === undefined ? result : { ...result, headers: { "api-version": apiVersion, ...result.headers } };
  };

  async function respond(event: APIGatewayProxyEventV2, log: Logger): Promise<Result> {
    const operation = operationForRouteKey(event.routeKey);
    if (!operation) return problem(404, "Not Found", `No operation in the contract for ${event.routeKey}.`);

    const handle = handlers[operation.operationId];
    if (!handle) return problem(501, "Not Implemented", `${operation.operationId} is in the contract but has no handler; run task generate.`);

    // API Gateway's authorizer has already refused callers without a valid
    // token; this holds the line if a secured route is ever wired up without one.
    const caller = callerOf(event);
    if (operation.secured && !caller) return unauthorized();

    let body: unknown;
    try {
      body = parseBody(event);
    } catch {
      return problem(400, "Bad Request", "The request body is not valid JSON.");
    }

    const checked = validateRequest(operation, {
      pathParameters: event.pathParameters ?? {},
      queryParameters: event.queryStringParameters ?? {},
      body,
    });
    if (!checked.ok) {
      return problem(400, "Bad Request", "The request does not satisfy the contract.", { errors: checked.violations });
    }

    try {
      return await handle({ ...checked.request, event, caller, log } as Context<never>);
    } catch (error) {
      if (error instanceof HttpProblem) return problem(error.status, error.title, error.detail);
      log.error("unhandled error", { error });
      return problem(500, "Internal Server Error");
    }
  }
}
