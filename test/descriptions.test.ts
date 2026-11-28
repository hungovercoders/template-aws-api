// What a person sees in the AWS console, and in the email an alarm sends:
// every resource that can say what it is does, and every alarm says what is
// wrong and links to the section of the docs that says what to do about it.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { blocks } from "../scripts/tags.ts";

// The types in infra/ that take a description. A new type that takes one is added here with its first resource.
const DESCRIBED = [
  "aws_apigatewayv2_api",
  "aws_apigatewayv2_integration",
  "aws_apigatewayv2_stage",
  "aws_cloudwatch_event_archive",
  "aws_cloudwatch_event_bus",
  "aws_cloudwatch_event_rule",
  "aws_iam_role",
  "aws_lambda_function",
  "aws_resourcegroups_group",
  "aws_scheduler_schedule",
];

const resources = blocks("infra").filter((block) => block.kind === "resource");
const said = (body: string, argument: string) => new RegExp(`^[ \\t]*${argument}[ \\t]*=`, "m").test(body);

/** A heading as the anchor GitHub gives it. */
const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ /g, "-");
const anchors = (file: string) =>
  existsSync(file)
    ? [...readFileSync(file, "utf8").matchAll(/^#+ (.+)$/gm)].map((match) => anchor(match[1]!))
    : [];

test("every resource that can say what it is, does", () => {
  const silent = resources.filter((block) => DESCRIBED.includes(block.type) && !said(block.body, "description"));
  expect(silent.map((block) => `${block.file}: ${block.type}.${block.name} has no description`)).toEqual([]);
});

test("every alarm says what is wrong and links to the section of the docs that says what to do", () => {
  const problems: string[] = [];
  for (const alarm of resources.filter((block) => block.type === "aws_cloudwatch_metric_alarm")) {
    const where = `${alarm.file}: ${alarm.name}`;
    if (!said(alarm.body, "alarm_description")) {
      problems.push(`${where} has no alarm_description`);
      continue;
    }
    // A link a person can open from the alarm: the repository's own docs, never a bare path.
    if (/Runbook: docs\//.test(alarm.body)) problems.push(`${where} names its runbook as a path; link it with \${local.docs}`);
    const links = [...alarm.body.matchAll(/Runbook: \$\{local\.docs\}\/([a-z-]+\.md)#([a-z0-9-]+)/g)];
    if (links.length === 0) problems.push(`${where} links to no runbook section`);
    for (const [, file, section] of links) {
      if (!anchors(`docs/${file}`).includes(section!)) problems.push(`${where} links to docs/${file}#${section}, which is not a heading there`);
    }
  }
  expect(problems).toEqual([]);
});
