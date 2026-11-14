// Once the contract has operations this repository is an API, not a template,
// and its front page should say so. This writes the README's API section from
// the contract - title, description, version, every operation and who may
// call it.
//   node scripts/readme.ts generate   - write it (the first time, it replaces the template's README)
//   node scripts/readme.ts check      - gate: it matches the contract
// Only the block between the api:start and api:end markers is generated.
// Everything after it is yours and is never touched.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const README = "README.md";
const START = "<!-- api:start - generated from specs/openapi.yaml by `task readme:generate`. Change the contract, not this block. -->";
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

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
const block = [
  START,
  `# ${contract.info?.title ?? "API"}`,
  "",
  (contract.info?.description ?? "").trim().replace(/\s*\n\s*/g, " "),
  "",
  `**Version ${contract.info?.version}** · [contract](specs/openapi.yaml) · [behaviour](specs/features) · [try it](http/contract.http)`,
  "",
  "## Operations",
  "",
  "| Operation | Request | Caller | What it does |",
  "| --- | --- | --- | --- |",
  ...operations.map((op) => `| \`${op.id}\` | \`${cell(op.request)}\` | ${op.caller} | ${cell(op.summary)} |`),
  "",
  "## Working on it",
  "",
  "| Task | What it does |",
  "| --- | --- |",
  "| `task dev` | Run the API locally on http://127.0.0.1:3000 |",
  "| `task http` | Send it the requests in `http/contract.http` |",
  "| `task mock` | Serve the contract as a mock, with nothing implemented |",
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
        ? "readme:check failed\n  - the API section of README.md no longer matches the contract; run `task readme:generate` and commit it"
        : "readme:check failed\n  - README.md still describes the template, but the contract now describes an API; run `task readme:generate` and commit it",
    );
    process.exit(1);
  }
  console.log(`readme:check ok - README.md describes ${contract.info?.title} ${contract.info?.version}, ${operations.length} operations`);
} else {
  writeFileSync(README, next);
  console.log(`readme:generate - README.md describes ${contract.info?.title} ${contract.info?.version}, ${operations.length} operations`);
}
