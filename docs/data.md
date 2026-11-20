# Events as data

> **For** whoever specifies, reads or operates the events an API keeps in S3. **When** writing or changing the data contract, querying the data, a data gate fails, or a data alarm has fired.

Every event the API publishes is also kept in S3, where analysts and other
systems read it long after it was sent. That is a product of its own, with a
promise of its own: `specs/datacontract.v<N>.yaml`, an
[Open Data Contract Standard](https://bitol-io.github.io/open-data-contract-standard/)
(ODCS) document per live major. It says what the data is, who owns it, how
sensitive each property is, where it is kept, for how long, and how soon after
an event happens it is there to read - and the data is tested against it.

An API with no data contract keeps nothing: the bucket and everything
around it are created only when the file exists.

## What is kept, and where

For each live major of the data contract, a rule on the event bus sends
every event the API publishes to that major's Firehose stream, which writes
the whole CloudEvent as one line of JSON under that major's location:

```
s3://<bucket>/<prefix ending /v<N>/>type=<event type>/dt=<date it arrived>/
```

So while `v1` and `v2` are both live, every event lands under both, and each
major's readers read their own. Every major uses the same bucket; its `id`
ends `-v<N>` and its objects are named after the messages, `beer_created_v1`.
A breaking change - a property removed, a type changed - goes in the next
major's file; a major is retired by publishing it with `status: deprecated`,
then deleting it.

An event is delivered at least once, so it can be stored more than once:
tell a repeat by its `id`. A record Firehose cannot place - not JSON, or with
no `type` - goes under `errors/`, never dropped.

**Compacted to Parquet, daily.** A little after midnight UTC a schedule runs
the compactor (`src/compactor.ts`). For each major and event type it rewrites
the last three days as one Parquet file per day the events *happened*, under
the major's `<server>-parquet` location:

```
s3://<bucket>/<parquet prefix ending /v<N>/>type=<event type>/dt=<day it happened>/events.parquet
```

Each file is typed by the contract - a column per property, `data` a struct -
and holds each event once. Rewriting a day gives the same file, so a run
again is harmless, and an event that arrives late is in the next run. An event
the contract's types cannot hold is left out, logged with its id, and is
still in the raw JSON. The raw JSON is kept for `data_raw_retention_days`
(30), the Parquet for the contract's retention; read the Parquet for any whole
day, the raw JSON for today.

## The contract

`task data:generate` writes what the AsyncAPI contract already decides: a
schema object for every event the API publishes (named after its message,
with the event's `type` as its `physicalName`), and each property's type,
limits and whether it is required. Run it whenever the AsyncAPI contract
changes; it keeps everything a person wrote. The rest is the owner's to say:

| In the contract | What it is | What follows from it |
| --- | --- | --- |
| `team`, `description.purpose` | Who owns the data and what it is for | Required by `data:lint` |
| `classification` on every property | `public`, `internal`, `confidential` or `restricted` | Required by `data:lint` |
| `servers`, the one named `production` | `type: s3`, `location: s3://<bucket>/<prefix>/`, `format: json`, `delimiter: new_line` | The bucket and prefix Terraform creates and Firehose writes to |
| `servers`, `production-parquet` | `type: s3`, the same bucket, a prefix of its own, `format: parquet` | Where the compactor writes each day |
| `slaProperties`, `retention` | How long an event is kept (`unit: d` or `y`) | The bucket's lifecycle rule |
| `slaProperties`, `latency` | How soon an event is there to read (`unit: s`, `m`, `h` or `d`) | The threshold of the `data-freshness` alarm |
| `quality` | Rules the data keeps, on an object or a property | Tested against what landed |
| `context` (optional) | How to use the data, for people and for AI | Nothing is required of it |

A stack that is not production - a test environment in AWS - needs a server
of its own in the contract, and is deployed with `-var data_server=<name>`.

## Gates

| Task | What it holds |
| --- | --- |
| `task data:lint` | The contract is valid ODCS (the [Data Contract CLI](https://cli.datacontract.com)) and meets the house rules in `rules/datacontract.yaml`; this API's own go in `.spectral.datacontract.yaml` |
| `task data:check` | Each major is of the ODCS version the template pins (`ODCS_VERSION` in `Taskfile.yml`), describes every published event exactly as the AsyncAPI contract has it, carries its major in its version, `id` and location, and says what the infrastructure reads |
| `task data:compat` | What changed since each major was last published (the CLI's changelog), and that its `version` says so: a breaking change to a published major is refused - it goes in the next major's file |
| `task data:test` | The data keeps the contract: types, required properties, limits and quality rules - tested where it is, in the bucket; nothing is copied. Then the Parquet, the same way, with each `id` there once. In `task acceptance` it runs after the features, on the events the scenarios published, every one of which must have landed - and then runs the compactor, and every one must be in the Parquet exactly once. `ENV=aws task data:test` tests the last two days of the deployed stack's data (`DATA_DAYS`), each day by itself, so a rule about the whole - an `id` that repeats - is held within a day |

## Reading the data

| Task | What it does |
| --- | --- |
| `task data:query -- "select * from beer_rated_v1"` | Runs SQL through DuckDB over the newest major's data, or the one `DATA_MAJOR=v<N>` names. Each event has a view over its Parquet, named after its schema object, and one over its raw JSON, `<name>_raw`, up to the minute; each shows every event once, `data` is a struct (`data.score`) and `dt` the day. With no SQL it opens DuckDB's shell |
| `task data:compact` | Runs the compactor now, as its schedule does, today included |
| `task data:browse` | The same views in [Harlequin](https://harlequin.sh) |

Both read the data where it is, never from a copy: the local stack
(`task dev`) by default and the deployed one with `ENV=aws`. Against AWS
Emulator they set its endpoint, path-style URLs and its certificate
themselves. They need DuckDB's `httpfs` extension, which it downloads the
first time. Where it cannot - behind a proxy that only passes HTTPS - the
local stack's data is read from a private copy that is removed when the
task ends, and real data is not read at all: the task says what to do.

Other accounts read the bucket when the stack is deployed with
`-var 'data_reader_accounts=["123456789012"]'`.

## Deploying

`-var data_compression=GZIP` makes each file about a fifth of the size, for a
volume where storage matters. The cost: the Data Contract CLI cannot read a
gzipped file, so `data:test` then needs an unpacked copy. With `ENV=aws` it
refuses to make one unless told `DATA_COPY=yes`; the copy is private and
removed when the test ends. Leave it off for data that must not leave AWS.
After a switch from gzip, the days that still hold gzipped files are
named and not tested until they age out of the days tested.
Querying is unaffected: DuckDB reads either where it is.

`-var data_buffer_seconds=N` is how long Firehose gathers events before it
writes a file: 300 by default, and it must be well inside the contract's
`latency`. The local stack uses 0, so a test does not wait.

A deploy never deletes a bucket that holds events: moving the data to
another bucket, or dropping the contract, fails until the old bucket has
been emptied by hand. Shortening `retention` does delete data.

With CI deploying (`docs/deploying.md`), the deploy role may manage only the
buckets the contract names: apply `infra/bootstrap` again after adding a
server to it.

## Alarms

| Alarm | Fires when | What it means |
| --- | --- | --- |
| `<name>-data-v<N>-delivery` | Firehose failed to write to S3 in 5 minutes | Events are published but not being kept |
| `<name>-data-v<N>-freshness` | The oldest event not yet in S3 is older than the contract's `latency` | The data is staler than promised |
| `<name>-data-v<N>-rule` | The bus could not hand an event to Firehose in 5 minutes | Events are published but not reaching the stream |
| `<name>-data-compaction` | The compactor failed | The Parquet is behind the raw JSON |

AWS Emulator emits no Firehose metrics, so the first two are created there
but never change state; only a deployed stack shows them firing.

### data-delivery

**Means** Firehose cannot write to the bucket. It keeps trying for a day;
after that the events are lost as data, though they were published.

1. The stream's error is in the Firehose console, under its destination
   error logs; `errors/` in the bucket holds what could not be placed.
2. **Usually** the bucket or the stream's role was changed outside
   Terraform. `task deploy` puts both back.
3. Lost for good: the bus's archive can replay the period to the rule.

### data-freshness

**Means** events are reaching Firehose but waiting longer than the contract
promises before they are in S3.

1. Check `data-delivery`: a failing delivery is the usual cause.
2. Otherwise `data_buffer_seconds` is too close to the contract's `latency`.
   Lower the buffer, or agree a longer `latency` with the data's readers -
   a change to the contract.

### data-rule

**Means** the rule that feeds Firehose is failing: the bus has the events,
the stream does not.

1. The rule is `<name>-data-v<N>`; its role is `<name>-data`. **Usually** the
   role or the stream was changed or removed outside Terraform.
2. `task deploy` puts them back; replay the gap from the bus's archive.

### data-compaction

**Means** the daily run that writes the Parquet failed, so the last days are
in the raw JSON only. Nothing is lost while the raw JSON is kept.

1. Its log, `/aws/lambda/<name>-data-compactor`, says why: a timeout on a
   large day, or the bucket or its role changed outside Terraform.
2. Fix that, then `ENV=aws DATA_DAYS=<days behind> task data:compact` writes the
   days again; the next run catches up three days by itself.
