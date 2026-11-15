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
  expect(repositoryUrl("ssh://git@gitlab.example.com/acme/beer-api.git")).toBe("https://gitlab.example.com/acme/beer-api");
  // Never the credentials a remote was cloned with.
  expect(repositoryUrl("https://someone:token@github.com/acme/beer-api")).toBe("https://github.com/acme/beer-api");
  expect(repositoryUrl("not a remote")).toBeUndefined();
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
