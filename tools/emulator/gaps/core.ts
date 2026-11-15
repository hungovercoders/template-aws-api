// The emulator gaps every API on the template lives with.
import { ApiGatewayV2Client, CreateApiCommand, CreateAuthorizerCommand, CreateIntegrationCommand, CreateRouteCommand, CreateStageCommand } from "@aws-sdk/client-apigatewayv2";
import { AddPermissionCommand, InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateGroupCommand, ListGroupResourcesCommand, ResourceGroupsClient } from "@aws-sdk/client-resource-groups";
import { createSign, generateKeyPairSync } from "node:crypto";
import { type Gap, lambdaFunction, queue, role, sleep, terraform } from "../lib.ts";

const lambda = new LambdaClient({});

// A token with the right issuer and audience, signed by a key nobody published.
function strangersToken(issuer: string, audience: string): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${part({ alg: "RS256", typ: "JWT", kid: "unknown" })}.${part({ iss: issuer, aud: audience, sub: "stranger", iat: now, exp: now + 600 })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url")}`;
}

export const gaps: Gap[] = [
  {
    id: "lambda-node-modules",
    kind: "limit",
    gap: "The emulator's Node runtime has no node:http, node:https or node:module; a function that imports one fails to load.",
    then: "docs/testing.md and the implement-api skill warn that a dependency needing them fails locally. Take the warning out of both.",
    where: ["docs/testing.md", ".claude/skills/implement-api/SKILL.md"],
    async test() {
      const modules = ["node:http", "node:https", "node:module"];
      const code = `export const handler = async () => { const out = {}; for (const name of ${JSON.stringify(modules)}) { try { await import(name); out[name] = "ok"; } catch (error) { out[name] = String(error.message); } } return out; };`;
      await lambdaFunction("gap-lambda-node-modules", await role("gap-lambda-node-modules"), code);
      const invoked = await lambda.send(new InvokeCommand({ FunctionName: "gap-lambda-node-modules" }));
      if (invoked.FunctionError) throw new Error(`the function failed: ${Buffer.from(invoked.Payload ?? []).toString()}`);
      const loaded = JSON.parse(Buffer.from(invoked.Payload ?? []).toString()) as Record<string, string>;
      const missing = modules.filter((name) => loaded[name] !== "ok");
      for (const name of missing) if (!/Cannot find module/.test(loaded[name] ?? "")) throw new Error(`${name} failed another way: ${loaded[name]}`);
      return missing.length > 0;
    },
  },
  {
    id: "jwt-signature",
    kind: "limit",
    gap: "The emulator's JWT authorizer checks a token's issuer and audience but not its signature.",
    then: "local/token.ts signs local tokens with a throwaway key, and docs/testing.md says signatures are only proven by a deploy. Local tokens then need an issuer that publishes its keys.",
    where: ["local/token.ts", "docs/testing.md"],
    async test() {
      const api = new ApiGatewayV2Client({});
      const name = "gap-jwt-signature";
      const [issuer, audience] = ["https://issuer.invalid/", "gap"];
      const fn = await lambdaFunction(name, await role(name), `export const handler = async () => ({ statusCode: 200, body: "reached" });`);
      const made = await api.send(new CreateApiCommand({ Name: name, ProtocolType: "HTTP" }));
      await lambda.send(new AddPermissionCommand({ FunctionName: name, StatementId: "api", Action: "lambda:InvokeFunction", Principal: "apigateway.amazonaws.com" }));
      const integration = await api.send(new CreateIntegrationCommand({ ApiId: made.ApiId, IntegrationType: "AWS_PROXY", IntegrationUri: fn, PayloadFormatVersion: "2.0" }));
      const authorizer = await api.send(
        new CreateAuthorizerCommand({ ApiId: made.ApiId, Name: name, AuthorizerType: "JWT", IdentitySource: ["$request.header.Authorization"], JwtConfiguration: { Issuer: issuer, Audience: [audience] } }),
      );
      await api.send(
        new CreateRouteCommand({ ApiId: made.ApiId, RouteKey: "GET /probe", Target: `integrations/${integration.IntegrationId}`, AuthorizationType: "JWT", AuthorizerId: authorizer.AuthorizerId }),
      );
      await api.send(new CreateStageCommand({ ApiId: made.ApiId, StageName: "$default", AutoDeploy: true }));
      // Through the emulator, whatever host the API's own endpoint names: a release may name AWS there, as it does for queues.
      const emulator = process.env.AWS_ENDPOINT_URL ?? "";
      const base = new URL(made.ApiEndpoint ?? "").host === new URL(emulator).host ? made.ApiEndpoint : `${emulator}/_aws/execute-api/${made.ApiId}`;
      const call = (headers: Record<string, string>) =>
        fetch(`${base}/probe`, { headers }).then(
          (response) => response.status,
          (error: Error) => Promise.reject(new Error(`could not call ${base}/probe: ${(error.cause as Error | undefined)?.message ?? error.message}`)),
        );
      // The authorizer must be in force before its leniency means anything.
      const unsigned = await call({});
      if (unsigned !== 401) throw new Error(`a request with no token got ${unsigned}, not 401: the authorizer is not in force`);
      const stranger = await call({ Authorization: `Bearer ${strangersToken(issuer, audience)}` });
      if (stranger === 200) return true;
      if (stranger === 401) return false;
      throw new Error(`a token signed by an unknown key got ${stranger}, neither 200 nor 401`);
    },
  },
  {
    id: "resource-group-members",
    kind: "limit",
    gap: "A resource group built from a tag query is created, but lists none of the resources that carry the tag.",
    then: "docs/testing.md says the service's resource group is only proven by a deploy. Say it is emulated, and a scenario or unit test may read it.",
    where: ["infra/tags.tf", "docs/testing.md"],
    async test() {
      const groups = new ResourceGroupsClient({});
      const name = "gap-resource-group-members";
      const tagged = await queue(name, {}, { service: name });
      const query = { ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "service", Values: [name] }] };
      await groups.send(new CreateGroupCommand({ Name: name, ResourceQuery: { Type: "TAG_FILTERS_1_0", Query: JSON.stringify(query) } }));
      await sleep(2000);
      const listed = await groups.send(new ListGroupResourcesCommand({ Group: name }));
      const members = [...(listed.Resources ?? []).map((resource) => resource.Identifier?.ResourceArn), ...(listed.ResourceIdentifiers ?? []).map((resource) => resource.ResourceArn)];
      return !members.includes(tagged.arn);
    },
  },
  {
    id: "table-repeat-apply",
    kind: "limit",
    gap: "A second `terraform apply` of an on-demand DynamoDB table fails: the provider's UpdateTable is refused as changing nothing.",
    then: "local/stack.mjs starts a new emulator and a new state for every run, so nothing applies twice. A running `task dev` could then take a changed infra/ without a restart.",
    where: ["local/stack.mjs"],
    async test() {
      const applied = await terraform("table-repeat-apply", { again: ["revision=2"] });
      if (applied.ok) return false;
      if (/UpdateTable/.test(applied.output) && /ValidationException/.test(applied.output)) return true;
      throw new Error(`the apply failed another way\n${applied.output.trim().slice(-1500)}`);
    },
  },
  {
    id: "queue-url-host",
    kind: "workaround",
    gap: "A queue's URL names sqs.<region>.amazonaws.com, not the emulator, so a client that follows the URL calls AWS.",
    then: "Every SQS client is made with `useQueueUrlAsEndpoint: false`. Make them with no option.",
    where: ["src/lib/consumer.ts", "src/lib/forwarder.ts", "steps/messages.ts", "local/queue.ts", "local/events.ts"],
    async test() {
      const made = await queue("gap-queue-url-host");
      return new URL(made.url).host !== new URL(process.env.AWS_ENDPOINT_URL ?? "").host;
    },
  },
];
