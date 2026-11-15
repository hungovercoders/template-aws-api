// The tags every resource carries (scripts/tags.ts): where the `repo` tag
// comes from, and the gate that no resource is created without them.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repositoryUrl, untagged, values } from "../scripts/tags.ts";

test("the repo tag is the remote as a person would open it", () => {
  expect(repositoryUrl("https://github.com/acme/beer-api.git\n")).toBe("https://github.com/acme/beer-api");
  expect(repositoryUrl("git@github.com:acme/beer-api.git")).toBe("https://github.com/acme/beer-api");
  expect(repositoryUrl("ssh://git@gitlab.example.com:2222/acme/beer-api.git")).toBe("https://gitlab.example.com/acme/beer-api");
  expect(repositoryUrl("https://git.example.com:8443/acme/beer-api")).toBe("https://git.example.com:8443/acme/beer-api");
  // Never the credentials a remote was cloned with.
  expect(repositoryUrl("https://someone:token@github.com/acme/beer-api")).toBe("https://github.com/acme/beer-api");
  // Nowhere a person could open.
  expect(repositoryUrl("not a remote")).toBeUndefined();
  expect(repositoryUrl("file:///srv/git/beer-api.git")).toBeUndefined();
  expect(repositoryUrl("/srv/git/beer-api.git")).toBeUndefined();
});

test("the owner's values are read from the committed file, and a missing one is empty, never a placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "tags-test-"));
  writeFileSync(join(dir, "tags.json"), JSON.stringify({ domain: " brewing ", team: "" }));
  expect(values(join(dir, "tags.json"))).toEqual({ domain: "brewing", team: "" });
  expect(values(join(dir, "none.json"))).toEqual({ domain: "", team: "" });
});

const schemas = {
  provider_schemas: {
    aws: { resource_schemas: { aws_sqs_queue: { block: { attributes: { name: {}, tags: {}, tags_all: {} } } } } },
    awscc: { resource_schemas: { awscc_s3_bucket: { block: { attributes: { bucket_name: {}, tags: {} } } }, awscc_thing_policy: { block: { attributes: { name: {} } } } } },
  },
};
const infra = (files: Record<string, string>) => {
  const dir = join(mkdtempSync(join(tmpdir(), "tags-test-")), "infra");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const provider = 'provider "aws" {\n  region = var.region\n\n  default_tags {\n    tags = local.tags\n  }\n}\n';

test("a stack whose aws provider has default tags, and whose other resources are given them by name, passes", () => {
  const dir = infra({
    "main.tf": `${provider}\nresource "aws_sqs_queue" "messages" {\n  name = "q"\n}\n`,
    "data.tf": 'resource "awscc_s3_bucket" "data" {\n  bucket_name = "b"\n  tags        = [for key, value in local.tags : { key = key, value = value }]\n}\n\nresource "awscc_thing_policy" "p" {\n  name = "cannot carry tags"\n}\n',
  });
  expect(untagged(dir, schemas)).toEqual([]);
});

test("an aws provider without the default tags fails: nothing it creates would be tagged", () => {
  const dir = infra({ "main.tf": 'provider "aws" {\n  region = var.region\n}\n' });
  expect(untagged(dir, schemas)).toEqual([expect.stringContaining("default_tags")]);
});

test("a resource of another provider that can carry tags and is not given them fails, by name", () => {
  const dir = infra({ "main.tf": provider, "data.tf": 'resource "awscc_s3_bucket" "data" {\n  bucket_name = "b"\n}\n\nresource "awscc_s3_bucket" "own" {\n  bucket_name = "c"\n  tags        = [{ key = "mine", value = "only" }]\n}\n' });
  expect(untagged(dir, schemas)).toEqual([expect.stringContaining("awscc_s3_bucket.data can carry tags"), expect.stringContaining("awscc_s3_bucket.own can carry tags")]);
});

test("a resource whose provider's schema is not known fails rather than passing unseen", () => {
  const dir = infra({ "main.tf": `${provider}\nresource "other_widget" "w" {\n  name = "w"\n}\n` });
  expect(untagged(dir, schemas)).toEqual([expect.stringContaining("other_widget.w")]);
});

test("every aws provider needs the default tags, an aliased one too, however its block is laid out", () => {
  const laid = 'provider "aws" {\n  region = var.region\n\n  assume_role {\n    role_arn = "arn:${var.x}"\n  }\n\n  # } a brace in a comment\n  default_tags {\n    tags = local.tags\n  }\n}\n';
  expect(untagged(infra({ "main.tf": laid }), schemas)).toEqual([]);
  const aliased = `${provider}\nprovider "aws" {\n  alias  = "us_east_1"\n  region = "us-east-1"\n}\n`;
  expect(untagged(infra({ "main.tf": aliased }), schemas)).toEqual([expect.stringContaining("default_tags")]);
  const other = 'provider "aws" {\n  default_tags {\n    tags = { service = "x" }\n  }\n}\n';
  expect(untagged(infra({ "main.tf": other }), schemas)).toEqual([expect.stringContaining("default_tags")]);
});

test("an aws resource may add tags of its own but never replace one of the stack's", () => {
  const adds = `${provider}\nresource "aws_sqs_queue" "q" {\n  name = "q"\n  tags = { purpose = "orders" }\n}\n`;
  expect(untagged(infra({ "main.tf": adds }), schemas)).toEqual([]);
  const replaces = `${provider}\nresource "aws_sqs_queue" "q" {\n  name = "q"\n  tags = {\n    service = "other"\n    team    = "x"\n  }\n}\n`;
  expect(untagged(infra({ "main.tf": replaces }), schemas)).toEqual([expect.stringContaining("aws_sqs_queue.q sets team, service itself")]);
  // A type the provider does not tag by default has to be given them.
  const group = `${provider}\nresource "aws_autoscaling_group" "g" {\n  name = "g"\n}\n`;
  expect(untagged(infra({ "main.tf": group }), schemas)).toEqual([expect.stringContaining("aws_autoscaling_group.g does not take")]);
});

test("tags given by name are read as written: over several lines, and not from a comment or a look-alike", () => {
  const bucket = (tags: string) => infra({ "main.tf": provider, "data.tf": `resource "awscc_s3_bucket" "data" {\n  bucket_name = "b"\n${tags}\n}\n` });
  expect(untagged(bucket("  tags = merge(\n    local.tags,\n    { purpose = \"x\" },\n  )"), schemas)).toEqual([]);
  expect(untagged(bucket("  tags = [\n    for key, value in local.tags : { key = key, value = value }\n  ]"), schemas)).toEqual([]);
  expect(untagged(bucket("  tags = [] # local.tags"), schemas)).toHaveLength(1);
  expect(untagged(bucket("  tags = local.tags_other"), schemas)).toHaveLength(1);
  // Not the resource's own argument.
  expect(untagged(bucket("  nested {\n    tags = local.tags\n  }"), schemas)).toHaveLength(1);
});

test("Terraform in a subdirectory is read too, and a module is named rather than passed unseen", () => {
  const dir = infra({ "main.tf": `${provider}\nmodule "queue" {\n  source = "./queue"\n}\n` });
  mkdirSync(join(dir, "queue"));
  writeFileSync(join(dir, "queue", "main.tf"), 'resource "awscc_s3_bucket" "inner" {\n  bucket_name = "b"\n}\n');
  expect(untagged(dir, schemas)).toEqual([expect.stringContaining('module "queue"'), expect.stringContaining("awscc_s3_bucket.inner")]);
});
