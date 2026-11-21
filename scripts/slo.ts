// The API's service level objectives: specs/slos/<name>.yaml, one OpenSLO v1 SLO each
// (https://github.com/openslo/openslo). OpenSLO's own CLI, oslo (pinned in mise.toml),
// says whether a file is valid OpenSLO; this says whether it is one the template acts on,
// because infra/alarms.tf turns each into an alarm at its objective:
//
//   availability - a ratioMetric of API Gateway's 5xx over its Count: the api-5xx alarm
//                  fires when the share of server errors passes 1 - target.
//   latency      - a thresholdMetric of API Gateway's Latency at a percentile (p50 .. p99.9),
//                  with `op: lte` and `value` in milliseconds: for the whole API, the
//                  api-latency alarm; with `metadata.labels.operation` naming an operationId,
//                  an alarm on that operation's route.
//
// The files name no stack: the alarm reads the metric for the stack it is deployed in.
//   node scripts/slo.ts check
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { contracts } from "./contracts.ts";

export const DIR = "specs/slos";
const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
] as const;

type Source = {
  type?: string;
  spec?: { namespace?: string; metricName?: string; stat?: string };
};
export type Slo = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, unknown> };
  spec?: {
    indicator?: {
      spec?: {
        ratioMetric?: {
          counter?: boolean;
          bad?: { metricSource?: Source };
          total?: { metricSource?: Source };
        };
        thresholdMetric?: { metricSource?: Source };
      };
    };
    objectives?: { op?: string; value?: number; target?: number }[];
  };
};
export type Shape =
  | { kind: "availability"; target: number }
  | { kind: "latency"; stat: string; milliseconds: number; operation?: string };

const gateway = (source: Source | undefined, metric: string) =>
  source?.type === "CloudWatch" &&
  source.spec?.namespace === "AWS/ApiGateway" &&
  source.spec?.metricName === metric;

/** What the template turns an SLO into, or why it cannot. */
export function shapeOf(slo: Slo): Shape | string {
  const indicator = slo.spec?.indicator?.spec;
  const objectives = slo.spec?.objectives ?? [];
  if (objectives.length !== 1)
    return "has more than one objective; give each its own SLO, so each has its own alarm";
  const [objective] = objectives as [
    { op?: string; value?: number; target?: number },
  ];
  const operation = slo.metadata?.labels?.operation;
  if (
    indicator?.ratioMetric &&
    gateway(indicator.ratioMetric.bad?.metricSource, "5xx") &&
    gateway(indicator.ratioMetric.total?.metricSource, "Count")
  ) {
    if (operation !== undefined)
      return "is an availability SLO for one operation; the template measures availability for the whole API, so drop its operation label";
    return { kind: "availability", target: objective.target ?? 0 };
  }
  const threshold = indicator?.thresholdMetric?.metricSource;
  if (gateway(threshold, "Latency")) {
    const stat = threshold?.spec?.stat ?? "";
    if (!/^p(\d{1,2}(\.\d+)?)$/.test(stat))
      return `measures Latency at ${JSON.stringify(stat)}; the template reads a percentile, p50 to p99.9`;
    if (
      objective.op !== "lte" ||
      typeof objective.value !== "number" ||
      objective.value <= 0
    )
      return "needs an objective `op: lte` and a `value` in milliseconds: how slow the slowest answers it covers may be";
    return {
      kind: "latency",
      stat,
      milliseconds: objective.value,
      ...(typeof operation === "string" ? { operation } : {}),
    };
  }
  return "is neither shape the template turns into an alarm: availability (a ratioMetric of AWS/ApiGateway 5xx over Count) or latency (a thresholdMetric of AWS/ApiGateway Latency at a percentile)";
}

/** Everything about these SLOs the template cannot act on. `operations` are the live majors' operationIds. */
export function sloProblems(
  files: { path: string; slo: Slo }[],
  operations: string[],
): string[] {
  const problems: string[] = [];
  const shapes = files.map(({ path, slo }) => ({
    path,
    slo,
    shape: shapeOf(slo),
  }));
  for (const { path, slo, shape } of shapes) {
    const name = slo.metadata?.name;
    if (`${DIR}/${name}.yaml` !== path)
      problems.push(
        `${path}: is named ${JSON.stringify(name)}; name the file after its SLO, ${DIR}/${name}.yaml`,
      );
    if (typeof shape === "string") problems.push(`${path}: ${shape}`);
    else if (
      shape.kind === "latency" &&
      shape.operation !== undefined &&
      !operations.includes(shape.operation)
    ) {
      problems.push(
        `${path}: its operation label names ${shape.operation}, which is not an operationId of any specs/contracts/openapi.v<N>.yaml`,
      );
    }
  }
  const valid = shapes
    .map(({ shape }) => shape)
    .filter((shape): shape is Shape => typeof shape !== "string");
  if (valid.filter((shape) => shape.kind === "availability").length > 1)
    problems.push(
      "more than one availability SLO: the API has one api-5xx alarm, so it has one",
    );
  if (
    valid.filter(
      (shape) => shape.kind === "latency" && shape.operation === undefined,
    ).length > 1
  )
    problems.push(
      "more than one latency SLO for the whole API: give the others an operation label, or keep one",
    );
  const routes = valid.flatMap((shape) =>
    shape.kind === "latency" && shape.operation ? [shape.operation] : [],
  );
  for (const operation of new Set(routes))
    if (routes.filter((other) => other === operation).length > 1)
      problems.push(
        `more than one latency SLO for ${operation}: keep the one its alarm should hold to`,
      );
  return problems;
}

function operationIds(): string[] {
  return contracts("openapi").flatMap((contract) => {
    const paths =
      (
        parse(readFileSync(contract.path, "utf8")) as {
          paths?: Record<string, Record<string, { operationId?: string }>>;
        }
      ).paths ?? {};
    return Object.values(paths).flatMap((item) =>
      METHODS.flatMap((method) =>
        item?.[method]?.operationId ? [item[method]!.operationId!] : [],
      ),
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // A file that is all comments - the template's starter - is an SLO not written yet: infra/alarms.tf skips it too.
  const paths = existsSync(DIR)
    ? readdirSync(DIR)
        .filter((name) => /\.ya?ml$/.test(name))
        .sort()
        .map((name) => `${DIR}/${name}`)
        .filter((path) => parse(readFileSync(path, "utf8")) != null)
    : [];
  if (paths.length === 0) {
    console.log(
      `slo:check - no SLO in ${DIR}/*.yaml yet, so the API's alarms keep the template's own thresholds`,
    );
    process.exit(0);
  }
  // OpenSLO's own validation first: the file is valid OpenSLO v1.
  const oslo = spawnSync(
    "oslo",
    ["validate", ...paths.flatMap((path) => ["-f", path])],
    { encoding: "utf8" },
  );
  if (oslo.error) {
    console.error(
      `slo:check failed - could not run oslo (${oslo.error.message}); it comes from mise.toml: run \`mise install\``,
    );
    process.exit(1);
  }
  if (oslo.status !== 0) {
    console.error(
      [
        "slo:check failed - not valid OpenSLO:",
        (oslo.stdout + oslo.stderr).trim(),
      ].join("\n"),
    );
    process.exit(1);
  }
  const problems = sloProblems(
    paths.map((path) => ({
      path,
      slo: parse(readFileSync(path, "utf8")) as Slo,
    })),
    operationIds(),
  );
  if (problems.length > 0) {
    console.error(
      ["slo:check failed", ...problems.map((problem) => `  - ${problem}`)].join(
        "\n",
      ),
    );
    process.exit(1);
  }
  console.log(
    `slo:check ok - ${paths.length} SLOs, valid OpenSLO, each one the alarms hold the API to`,
  );
}
