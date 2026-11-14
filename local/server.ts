// A local stand-in for API Gateway HTTP API: turns each HTTP request into the
// payload-format-2.0 event the Lambda receives on AWS and invokes the handler
// from dist/handler.mjs - the same bundle that is deployed, not the source.
// Routes come from the contract, exactly as infra/main.tf builds them.
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { matchRoute } from "../src/lib/contract.ts";
import { resetTable } from "./table.ts";

const bundle = new URL("../dist/handler.mjs", import.meta.url).href;
const { handler } = (await import(bundle)) as { handler: APIGatewayProxyHandlerV2 };

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function toEvent(req: IncomingMessage, url: URL, body: string, routeKey: string, pathParameters: Record<string, string>): APIGatewayProxyEventV2 {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(",") : (value ?? "");
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) query[name] = name in query ? `${query[name]},${value}` : value;
  const now = new Date();
  return {
    version: "2.0",
    routeKey,
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    ...(Object.keys(query).length > 0 ? { queryStringParameters: query } : {}),
    ...(Object.keys(pathParameters).length > 0 ? { pathParameters } : {}),
    requestContext: {
      accountId: "000000000000",
      apiId: "local",
      domainName: "localhost",
      domainPrefix: "local",
      http: { method: req.method!, path: url.pathname, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: headers["user-agent"] ?? "" },
      requestId: randomUUID(),
      routeKey,
      stage: "$default",
      time: now.toISOString(),
      timeEpoch: now.getTime(),
    },
    ...(body === "" ? {} : { body }),
    isBase64Encoded: false,
  };
}

const server = createServer(async (req, res) => {
  const send = (status: number, headers: Record<string, string>, body?: string) => {
    res.writeHead(status, headers);
    res.end(body);
  };
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await read(req);

    // Harness-only endpoints; they do not exist on AWS.
    if (url.pathname === "/__local/health") return send(200, { "content-type": "text/plain" }, "ok");
    if (url.pathname === "/__local/reset" && req.method === "POST") {
      await resetTable();
      return send(204, {});
    }

    const match = matchRoute(req.method!, url.pathname);
    // API Gateway answers unmatched routes itself; the Lambda never runs.
    if (!match) return send(404, { "content-type": "application/json" }, JSON.stringify({ message: "Not Found" }));

    let pathParameters: Record<string, string>;
    try {
      pathParameters = Object.fromEntries(Object.entries(match.pathParameters).map(([k, v]) => [k, decodeURIComponent(v)]));
    } catch {
      return send(400, { "content-type": "application/json" }, JSON.stringify({ message: "Bad Request" }));
    }

    const event = toEvent(req, url, body, match.operation.routeKey, pathParameters);
    const result = (await handler(event, {} as Context, () => {})) as APIGatewayProxyStructuredResultV2;
    const headers = Object.fromEntries(Object.entries(result.headers ?? {}).map(([k, v]) => [k, String(v)]));
    send(result.statusCode ?? 200, headers, result.isBase64Encoded ? Buffer.from(result.body ?? "", "base64").toString() : result.body);
  } catch (error) {
    console.error("local server error", error);
    send(500, { "content-type": "application/json" }, JSON.stringify({ message: "Internal Server Error" }));
  }
});

server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
  const address = server.address() as { port: number };
  console.log(`listening http://127.0.0.1:${address.port}`);
});
