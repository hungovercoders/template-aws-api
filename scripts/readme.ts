// Once the contract has operations this repository is an API, not a template,
// and its front page should say so. This writes the README's API section from
// the contract - title, description, version, every operation and who may
// call it.
//   node scripts/readme.ts generate   - write it (the first time, it replaces the template's README)
//   node scripts/readme.ts check      - gate: it matches the contract
// Only the block between the api:start and api:end markers is generated.
// Everything after it is yours and is never touched.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { removed } from "./components-lib.ts";
import { contracts, versionOf } from "./contracts.ts";

const README = "README.md";
const START = "<!-- api:start - generated from the contracts in specs/ by `task readme:generate`. Change a contract, not this block. -->";
const END = "<!-- api:end -->";
const BLOCK = /<!-- api:start[\s\S]*?<!-- api:end -->/;
const TEMPLATE = "https://github.com/hungovercoders/template-aws-api";

type Security = Record<string, string[]>[];
type Operation = { operationId?: string; summary?: string; security?: Security };
type Contract = { info?: { title?: string; description?: string; version?: string }; paths?: Record<string, Record<string, Operation>>; security?: Security };

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];
const contract = JSON.parse(readFileSync("src/generated/openapi.json", "utf8")) as Contract;
const mode = process.argv[2];

const operations = Object.entries(contract.paths ?? {}).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => {
    const operation = item[method]!;
    const security = operation.security ?? contract.security ?? [];
    return {
      id: operation.operationId ?? "",
      request: `${method.toUpperCase()} ${path}`,
      caller: security.length > 0 && security.every((requirement) => Object.keys(requirement).length > 0) ? "Signed in" : "Anyone",
      summary: operation.summary ?? "",
    };
  }),
);

if (operations.length === 0) {
  console.log(`readme:${mode} skipped - the contract declares no operations, so this is still the template`);
  process.exit(0);
}

// Each live major of a contract, as a link to its file: "v1 (1.4.0), v2 (2.0.1)".
const majors = (kind: "openapi" | "asyncapi" | "datacontract", only?: Set<number>) =>
  contracts(kind)
    .filter((contract) => !only || only.has(contract.major))
    .map((contract) => `[v${contract.major}](${contract.path}) (${versionOf(kind, parseYaml(readFileSync(contract.path, "utf8"))) ?? "?"})`)
    .join(", ");

// An API with an asynchronous side has a second contract, specs/asyncapi.v<N>.yaml:
// the messages it receives and the events it publishes are its front page too.
type Async = {
  info?: { version?: string };
  channels?: Record<string, { address?: string }>;
  operations?: Record<string, { action?: string; summary?: string; channel?: { $ref?: string } }>;
};
// Every live major's operations, each once.
const asyncOperations = [
  ...new Map(
    contracts("asyncapi").flatMap((contract) => {
      const document = parseYaml(readFileSync(contract.path, "utf8")) as Async;
      return Object.entries(document?.operations ?? {}).map(([id, operation]) => {
        const channel = operation.channel?.$ref?.split("/").at(-1) ?? "";
        return [id, { id, received: operation.action === "receive", on: document.channels?.[channel]?.address ?? channel, summary: operation.summary ?? "" }] as const;
      });
    }),
  ).values(),
];
const asyncSection = (title: string, received: boolean) => {
  const list = asyncOperations.filter((operation) => operation.received === received);
  return list.length === 0
    ? []
    : [`## ${title}`, "", "| Operation | On | What it does |", "| --- | --- | --- |", ...list.map((op) => `| \`${op.id}\` | \`${cell(op.on)}\` | ${cell(op.summary)} |`), ""];
};

// What the API has is what its contracts say and its repository still carries: a
// removed component's tasks and guides are not there to point at.
const gone = removed();
// Events kept as data have a third contract, specs/datacontract.v<N>.yaml: who
// owns the data, how long it is kept and how fresh it is belong on the front
// page. The newest major says it; every live one is linked.
type Data = { version?: string; team?: string | { name?: string }; slaProperties?: { property?: string; value?: unknown; unit?: string }[] };
const DATA = gone.has("data") ? undefined : contracts("datacontract").at(-1)?.path;
const dataContract = DATA && existsSync(DATA) ? (parseYaml(readFileSync(DATA, "utf8")) as Data) : undefined;
const UNITS: Record<string, string> = { s: "second", m: "minute", h: "hour", d: "day", y: "year" };
const promised = (property: string) => {
  const sla = dataContract?.slaProperties?.find((entry) => entry.property === property);
  return sla && UNITS[sla.unit ?? ""] ? `${sla.value} ${UNITS[sla.unit!]}${sla.value === 1 ? "" : "s"}` : undefined;
};
const dataSection = () => {
  if (!dataContract) return [];
  // A name, or an object that has one; any other shape is left to the contract to say.
  const team = typeof dataContract.team === "string" ? dataContract.team : dataContract.team?.name;
  const owner = team && `owned by ${/\bteam$/i.test(team.trim()) ? cell(team) : `the ${cell(team)} team`}`;
  const facts = [owner, promised("retention") && `kept for ${promised("retention")}`, promised("latency") && `there to read within ${promised("latency")}`].filter(Boolean);
  return [
    "## Events kept as data",
    "",
    `Every event it publishes is also kept in S3, under a data contract - ${majors("datacontract")}${facts.length > 0 ? `: ${facts.join(", ")}` : ""}.`,
    "See [events as data](docs/data.md) for how it is tested and queried.",
    "",
  ];
};
// The tasks of the parts this API has, beside the ones every API has.
const has = (received: boolean, component: string) => !gone.has(component) && asyncOperations.some((operation) => operation.received === received);
const ownTasks = () => [
  ...(has(true, "consume") ? ["| `task queue:send -- <message>` | Send it one of the example messages in `messages/` |"] : []),
  ...(has(false, "publish") ? ["| `task events:tail` | Follow the events it publishes |"] : []),
  ...(dataContract ? ['| `task data:query -- "<sql>"` | Query the events kept in S3, a view for each |'] : []),
];

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const block = [
  START,
  `# ${contract.info?.title ?? "API"}`,
  "",
  (contract.info?.description ?? "").trim().replace(/\s*\n\s*/g, " "),
  "",
  `**Versions** ${majors("openapi")}, each served under its own /v<major> · [behaviour](specs/features) · [try it](http/contract.http)`,
  "",
  "## Operations",
  "",
  "| Operation | Request | Caller | What it does |",
  "| --- | --- | --- | --- |",
  ...operations.map((op) => `| \`${op.id}\` | \`${cell(op.request)}\` | ${op.caller} | ${cell(op.summary)} |`),
  "",
  ...(asyncOperations.length > 0 ? [`Messages and events have contracts of their own - ${majors("asyncapi")} - with an [example of each](messages).`, ""] : []),
  ...asyncSection("Messages it receives", true),
  ...asyncSection("Events it publishes", false),
  ...dataSection(),
  "## Working on it",
  "",
  "| Task | What it does |",
  "| --- | --- |",
  "| `task dev` | Run the API on AWS Emulator; prints its URL and a token |",
  "| `task http` | Send it the requests in `http/contract.http` |",
  "| `task mock` | Serve the contract as a mock, with nothing implemented |",
  ...ownTasks(),
  "| `task ci` | Every gate, in order: the definition of done |",
  "",
  "What this API does is decided by its spec. To change it, change the",
  "contract and the feature files ([the spec](docs/spec.md)); the gates then say",
  "when the code has caught up ([testing](docs/testing.md)). See also",
  "[deploying](docs/deploying.md) and the [runbook](docs/runbook.md) for its alarms.",
  "",
  `Built on [template-aws-api](${TEMPLATE}), a BDD and contract driven template`,
  "for AWS Lambda APIs: the skeleton is the same for every API, and only the",
  "spec and the behaviour behind it are this API's own.",
  END,
].join("\n");

const NOTES = `

## Notes

Anything the contract cannot say - why this API exists, who owns it, where it
is deployed - goes below. \`task readme:generate\` never changes this part.
`;

const current = existsSync(README) ? readFileSync(README, "utf8") : "";
// A README without the block is still the template's: the API's replaces it.
const next = BLOCK.test(current) ? current.replace(BLOCK, () => block) : block + NOTES;

if (mode === "check") {
  if (current !== next) {
    console.error(
      BLOCK.test(current)
        ? "readme:check failed\n  - the API section of README.md no longer matches the contracts in specs/; run `task readme:generate` and commit it"
        : "readme:check failed\n  - README.md still describes the template, but the contract now describes an API; run `task readme:generate` and commit it",
    );
    process.exit(1);
  }
  console.log(`readme:check ok - README.md describes ${contract.info?.title} ${contract.info?.version}, ${operations.length} operations`);
} else {
  writeFileSync(README, next);
  console.log(`readme:generate - README.md describes ${contract.info?.title} ${contract.info?.version}, ${operations.length} operations`);
}
