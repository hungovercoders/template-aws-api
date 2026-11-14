// Routes API Gateway HTTP API events to operations by operationId, and holds
// every request to the contract before an operation sees it.
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from "aws-lambda";
import type { operations } from "../generated/api.d.ts";
import { operationForRouteKey, validateRequest } from "./contract.ts";
import { createLogger, type Logger } from "./log.ts";
import { HttpProblem, problem, type Result } from "./problem.ts";

type OperationId = keyof operations;
type Parameters<K extends OperationId, W extends "path" | "query"> = operations[K] extends { parameters: { [P in W]?: infer V } }
  ? NonNullable<V>
  : Record<string, never>;
type Body<K extends OperationId> = operations[K] extends { requestBody?: { content: { "application/json": infer B } } } ? B : undefined;

/** A request that has already passed contract validation. */
export type Context<K extends OperationId> = {
  path: Parameters<K, "path">;
  query: Parameters<K, "query">;
  body: Body<K>;
  event: APIGatewayProxyEventV2;
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
    const log = createLogger({
      request_id: event.requestContext?.requestId,
      route_key: event.routeKey,
      operation_id: operationForRouteKey(event.routeKey)?.operationId,
    });
    const result = await respond(event, log);
    log.info("request", { status: result.statusCode, duration_ms: Date.now() - started });
    return result;
  };

  async function respond(event: APIGatewayProxyEventV2, log: Logger): Promise<Result> {
    const operation = operationForRouteKey(event.routeKey);
    if (!operation) return problem(404, "Not Found", `No operation in the contract for ${event.routeKey}.`);

    const handle = handlers[operation.operationId];
    if (!handle) return problem(501, "Not Implemented", `${operation.operationId} is in the contract but has no handler in src/routes.ts.`);

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
      return await handle({ ...checked.request, event, log } as Context<never>);
    } catch (error) {
      if (error instanceof HttpProblem) return problem(error.status, error.title, error.detail);
      log.error("unhandled error", { error });
      return problem(500, "Internal Server Error");
    }
  }
}
