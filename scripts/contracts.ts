// Where the contracts are, and the names that let two major versions of one
// live side by side. An API keeps a file per live major of each contract,
//   specs/openapi.v<N>.yaml   specs/asyncapi.v<N>.yaml   specs/datacontract.v<N>.yaml
// where N is the major of the version the file declares. The stack serves,
// sends, receives and keeps the data of every one of them at once, so whatever
// two majors would share a name in carries the version:
//   - an HTTP path starts /v<N>/ and an operationId ends _v<N>
//   - an event's type ends .v<M>; its message and the operations that carry it end _v<M>
//   - a data contract's location ends /v<N>/ and its id -v<N>
// A file that was published is retired only after a published commit marked it
// deprecated: every operation `deprecated: true` (OpenAPI), `info.x-deprecated:
// true` (AsyncAPI), `status: deprecated` (ODCS) - see retired().
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { show } from "./spec-baseline.ts";

export type Kind = "openapi" | "asyncapi" | "datacontract";
export type Contract = { kind: Kind; path: string; major: number };

const SPECS = "specs";
const file = (kind: Kind, major: number) => `${SPECS}/${kind}.v${major}.yaml`;
const pattern = (kind: Kind) => new RegExp(`^${kind}\\.v(0|[1-9][0-9]*)\\.yaml$`);

/** Every live major of a contract, oldest first. */
export function contracts(kind: Kind): Contract[] {
  if (!existsSync(SPECS)) return [];
  return readdirSync(SPECS)
    .map((name) => pattern(kind).exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ kind, path: `${SPECS}/${match[0]}`, major: Number(match[1]) }))
    .sort((a, b) => a.major - b.major);
}

/** Files that name a contract the way the template no longer reads: what to call them instead. */
export function misnamed(kind: Kind): string[] {
  if (!existsSync(SPECS)) return [];
  return readdirSync(SPECS)
    .filter((name) => name.startsWith(`${kind}.`) && /\.(ya?ml|json)$/.test(name) && !pattern(kind).test(name))
    .map((name) => `${SPECS}/${name} is not read: a contract is ${SPECS}/${kind}.v<major>.yaml, the major of the version it declares (e.g. ${file(kind, 1)} for 1.4.0)`);
}

/** The version a contract declares. */
export function versionOf(kind: Kind, document: unknown): string | undefined {
  const value = kind === "datacontract" ? (document as { version?: unknown })?.version : (document as { info?: { version?: unknown } })?.info?.version;
  return typeof value === "string" ? value : undefined;
}

export const majorOf = (version: string | undefined) => {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version ?? "");
  return match ? Number(match[1]) : undefined;
};

/** Is the file's version a semantic version whose major is the one its name says? */
export function versionProblems(contract: Contract, document: unknown): string[] {
  const version = versionOf(contract.kind, document);
  const major = majorOf(version);
  if (major === undefined) return [`${contract.path} declares version "${version ?? ""}", which is not MAJOR.MINOR.PATCH`];
  if (major !== contract.major) return [`${contract.path} declares version ${version}; a file holds one major, so it is ${file(contract.kind, major)}, or its version is ${contract.major}.x.x`];
  return [];
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
type OpenApi = { paths?: Record<string, Record<string, { operationId?: string; deprecated?: boolean }>> };

/** An HTTP contract's paths start /v<N> and its operationIds end _v<N>, so another major's can sit beside them. */
export function openapiNameProblems(contract: Contract, document: OpenApi): string[] {
  const problems: string[] = [];
  const prefix = `/v${contract.major}`;
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) problems.push(`${contract.path}: path ${path} does not start ${prefix}/ - each major is served under its own prefix`);
    for (const method of METHODS.filter((m) => item?.[m])) {
      const id = item[method]!.operationId;
      if (id && !id.endsWith(`_v${contract.major}`)) problems.push(`${contract.path}: operationId ${id} does not end _v${contract.major} - it names a handler and a tag beside other majors' (e.g. ${id.replace(/_v\d+$/, "")}_v${contract.major})`);
    }
  }
  return problems;
}

export type RateLimit = { requests_per_second?: unknown; burst?: unknown };
type Limited = { "x-rate-limit"?: RateLimit; paths?: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>> };

/**
 * A major's rate limit is part of its contract, where its callers read it: `x-rate-limit` at the
 * root, which API Gateway applies to each of its routes and answers 429 beyond. A limit and a
 * documented 429 go together - the one without the other misleads a caller.
 */
export function rateLimitProblems(path: string, document: Limited): string[] {
  const problems: string[] = [];
  const limit = document["x-rate-limit"];
  const whole = (value: unknown) => Number.isInteger(value) && (value as number) >= 1;
  if (limit !== undefined) {
    if (!whole(limit.requests_per_second) || !whole(limit.burst)) {
      problems.push(`${path}: x-rate-limit needs requests_per_second and burst, whole numbers from 1 - how fast a caller may call each operation, and how many requests at once`);
    } else if ((limit.burst as number) < (limit.requests_per_second as number)) {
      problems.push(`${path}: x-rate-limit's burst (${limit.burst}) is below its requests_per_second (${limit.requests_per_second}); a second's requests could never all arrive together`);
    }
  }
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS.filter((m) => item?.[m])) {
      const name = item[method]!.operationId ?? `${method.toUpperCase()} ${route}`;
      const documented = Boolean(item[method]!.responses?.["429"]);
      if (limit !== undefined && !documented) problems.push(`${path}: ${name} does not document 429, though the contract has a rate limit - API Gateway answers it beyond the limit`);
      if (limit === undefined && documented) problems.push(`${path}: ${name} documents 429, but the contract has no x-rate-limit to say when`);
    }
  }
  return problems;
}

type Message = { name: string; type?: string };
type AsyncOperation = { id: string; messages: Message[] };

/** An event's version is its type's .v<M>: its message and the operations that carry it end _v<M>. */
export function asyncapiNameProblems(path: string, operations: AsyncOperation[]): string[] {
  const problems: string[] = [];
  const majorOfType = (type: string | undefined) => (type === undefined ? undefined : /\.v([1-9][0-9]*)$/.exec(type)?.[1]);
  const seen = new Set<string>();
  for (const operation of operations) {
    const majors = new Set<string>();
    for (const message of operation.messages) {
      const major = majorOfType(message.type);
      if (major === undefined) continue; // the type's form is asyncapi:lint's
      majors.add(major);
      if (!seen.has(message.name) && !message.name.endsWith(`_v${major}`)) problems.push(`${path}: message ${message.name} has type ${message.type}, so its name ends _v${major} (${message.name.replace(/_v\d+$/, "")}_v${major})`);
      seen.add(message.name);
    }
    if (majors.size > 1) problems.push(`${path}: operation ${operation.id} carries messages of more than one version (${[...majors].map((m) => `v${m}`).join(", ")}); give each version an operation of its own`);
    const [major] = majors;
    if (majors.size === 1 && !operation.id.endsWith(`_v${major}`)) problems.push(`${path}: operation ${operation.id} carries v${major} messages, so its name ends _v${major} (${operation.id.replace(/_v\d+$/, "")}_v${major})`);
  }
  return problems;
}

type DataContract = { id?: string; servers?: { server?: string; location?: string }[] };

/** A data contract's id ends -v<N> and every location ends /v<N>/, so another major's data can land beside it. */
export function datacontractNameProblems(contract: Contract, document: DataContract): string[] {
  const problems: string[] = [];
  if (!document.id?.endsWith(`-v${contract.major}`)) problems.push(`${contract.path}: id "${document.id ?? ""}" does not end -v${contract.major}`);
  for (const server of document.servers ?? []) {
    if (server.location?.startsWith("s3://") && !server.location.endsWith(`/v${contract.major}/`)) {
      problems.push(`${contract.path}: server ${server.server} keeps the data at ${server.location}, which does not end /v${contract.major}/ - each major's data lands under its own prefix`);
    }
  }
  return problems;
}

/** Was this document marked deprecated - the step before its file may be removed? */
export function deprecated(kind: Kind, document: unknown): boolean {
  if (kind === "datacontract") return (document as { status?: string })?.status === "deprecated";
  if (kind === "asyncapi") return (document as { info?: Record<string, unknown> })?.info?.["x-deprecated"] === true;
  const operations = Object.values((document as OpenApi)?.paths ?? {}).flatMap((item) => METHODS.filter((m) => item?.[m]).map((m) => item[m]!));
  return operations.length > 0 && operations.every((operation) => operation.deprecated === true);
}

const HOW = {
  openapi: "mark every operation in it `deprecated: true`",
  asyncapi: "set `info.x-deprecated: true` in it",
  datacontract: "set `status: deprecated` in it",
};

/**
 * The majors the baseline had and this tree does not. Each was published, so
 * its consumers break when it goes: that is allowed once the baseline already
 * said it was deprecated, and refused otherwise.
 */
export function retired(kind: Kind, ref: string): { gone: Contract[]; problems: string[] } {
  const live = new Set(contracts(kind).map((contract) => contract.major));
  const listed = spawnNames(ref) ?? [];
  const before = listed.map((name) => pattern(kind).exec(name)).filter((match): match is RegExpExecArray => match !== null);
  const gone = before.map((match) => ({ kind, path: `${SPECS}/${match[0]}`, major: Number(match[1]) })).filter((contract) => !live.has(contract.major));
  const problems = gone
    .filter((contract) => !deprecated(kind, parse(show(ref, contract.path) ?? "") ?? {}))
    .map((contract) => `${contract.path} was removed, but the published one was not deprecated: whoever uses v${contract.major} breaks. First publish it deprecated (${HOW[kind]}), then remove it in a later change.`);
  return { gone, problems };
}

/** The baseline's version of one major: its own file, or a contract from before files were versioned when its major matches. */
export function atBaseline(contract: Contract, ref: string): string | undefined {
  const own = show(ref, contract.path);
  if (own !== undefined) return own;
  const legacy = show(ref, `${SPECS}/${contract.kind}.yaml`);
  if (legacy === undefined) return undefined;
  return majorOf(versionOf(contract.kind, parse(legacy))) === contract.major ? legacy : undefined;
}

function spawnNames(ref: string): string[] | undefined {
  const result = spawnSync("git", ["ls-tree", "--name-only", `${ref}:${SPECS}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : undefined;
}
