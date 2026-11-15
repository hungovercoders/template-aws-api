// The emulator gaps that come with keeping events as data in S3.
import { CloudWatchClient, ListMetricsCommand } from "@aws-sdk/client-cloudwatch";
import { CreateDeliveryStreamCommand, DescribeDeliveryStreamCommand, FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";
import { CreateBucketCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { type Gap, role, sleep, terraform } from "../lib.ts";

export const gaps: Gap[] = [
  {
    id: "s3-control",
    kind: "workaround",
    gap: "The emulator does not serve S3 Control, which the AWS provider's `aws_s3_bucket` calls, so that resource never finishes.",
    then: 'infra/data.tf makes the bucket with `awscc_s3_bucket`, through Cloud Control. Make it an `aws_s3_bucket` (a `moved` block cannot cross providers: `terraform state rm` and `import` for a deployed stack).',
    where: ["infra/data.tf"],
    async test() {
      // The provider retries the call for minutes, so the test stops it early and reads its log for that call.
      const applied = await terraform("s3-control", { seconds: 45, debug: true });
      if (applied.ok) return false;
      if (/retrying request S3 Control\/ListTagsForResource/.test(applied.output)) return true;
      throw new Error(`the apply failed, and not on S3 Control\n${applied.output.trim().slice(-1500)}`);
    },
  },
  {
    id: "cloud-control-bucket-settings",
    kind: "workaround",
    gap: "Through Cloud Control the emulator refuses a bucket that carries its own encryption or lifecycle.",
    then: "infra/data.tf sets both with `aws_s3_bucket_server_side_encryption_configuration` and `aws_s3_bucket_lifecycle_configuration`. Only worth changing if the bucket stays on `awscc_s3_bucket`.",
    where: ["infra/data.tf"],
    async test() {
      const applied = await terraform("cloud-control-bucket-settings");
      if (applied.ok) return false;
      if (/awscc_s3_bucket/.test(applied.output) && /InvalidRequest/.test(applied.output)) return true;
      throw new Error(`the apply failed another way\n${applied.output.trim().slice(-1500)}`);
    },
  },
  {
    id: "firehose-metrics",
    kind: "limit",
    gap: "Firehose delivers to S3 but reports no CloudWatch metrics.",
    then: "docs/testing.md says the data-delivery and data-freshness alarms never change state locally. A test could then show them firing.",
    where: ["infra/data.tf", "docs/testing.md"],
    async test() {
      const name = "gap-firehose-metrics";
      const s3 = new S3Client({ forcePathStyle: true });
      const firehose = new FirehoseClient({});
      await s3.send(new CreateBucketCommand({ Bucket: name }));
      const destination = { RoleARN: await role(name), BucketARN: `arn:aws:s3:::${name}`, BufferingHints: { IntervalInSeconds: 0, SizeInMBs: 1 } };
      await firehose.send(new CreateDeliveryStreamCommand({ DeliveryStreamName: name, DeliveryStreamType: "DirectPut", ExtendedS3DestinationConfiguration: destination }));
      for (let tries = 0; ; tries++) {
        const described = await firehose.send(new DescribeDeliveryStreamCommand({ DeliveryStreamName: name }));
        if (described.DeliveryStreamDescription?.DeliveryStreamStatus === "ACTIVE") break;
        if (tries === 30) throw new Error("the delivery stream did not become active");
        await sleep(1000);
      }
      await firehose.send(new PutRecordCommand({ DeliveryStreamName: name, Record: { Data: new TextEncoder().encode('{"n":1}\n') } }));
      // The metrics only mean something once the delivery they would report has happened.
      for (let tries = 0; ; tries++) {
        const objects = await s3.send(new ListObjectsV2Command({ Bucket: name }));
        if ((objects.KeyCount ?? 0) > 0) break;
        if (tries === 20) throw new Error("Firehose delivered nothing to the bucket");
        await sleep(1000);
      }
      await sleep(3000);
      const metrics = await new CloudWatchClient({}).send(new ListMetricsCommand({ Namespace: "AWS/Firehose", Dimensions: [{ Name: "DeliveryStreamName", Value: name }] }));
      return !(metrics.Metrics ?? []).some((metric) => metric.MetricName === "DeliveryToS3.Success");
    },
  },
];
