import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type Result = APIGatewayProxyStructuredResultV2;

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): Result {
  return { statusCode, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

export function noContent(): Result {
  return { statusCode: 204 };
}

/** An RFC 9457 problem response - the one error shape the API speaks. */
export function problem(status: number, title: string, detail?: string, extra: Record<string, unknown> = {}): Result {
  return {
    statusCode: status,
    headers: { "content-type": "application/problem+json" },
    body: JSON.stringify({ type: "about:blank", title, status, ...(detail ? { detail } : {}), ...extra }),
  };
}

/** Throw from an operation to answer with a problem response. */
export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}
