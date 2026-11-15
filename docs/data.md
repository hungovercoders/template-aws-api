# Events as data

> **For** whoever specifies, reads or operates the events an API keeps in S3. **When** writing or changing the data contract, querying the data, a data gate fails, or a data alarm has fired.

Every event the API publishes is also kept in S3, where analysts and other
systems read it long after it was sent. That is a product of its own, with a
promise of its own: `specs/datacontract.yaml`, an
[Open Data Contract Standard](https://bitol-io.github.io/open-data-contract-standard/)
(ODCS) document. It says what the data is, who owns it, how sensitive each
property is, where it is kept, for how long, and how soon after an event
happens it is there to read - and the data is tested against it.

An API with no data contract keeps nothing: the bucket and everything
around it are created only when the file exists.

## What is kept, and where

A rule on the event bus sends every event the API publishes to Firehose,
which writes the whole CloudEvent as one line of JSON under

```
s3://<bucket>/<prefix>type=<event type>/dt=<date it arrived>/
```

An event is delivered at least once, so it can be stored more than once:
tell a repeat by its `id`. A record Firehose cannot place - not JSON, or with
no `type` - goes under `errors/`, never dropped.

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
| `task data:check` | It is of the ODCS version the template pins (`ODCS_VERSION` in `Taskfile.yml`), describes every published event exactly as the AsyncAPI contract has it, and says what the infrastructure reads |
| `task data:compat` | What changed since the last published contract (the CLI's changelog), and that `version` says so: a breaking change - a property removed, a type changed - needs a new major version |
| `task data:test` | The data keeps the contract: types, required properties, limits and quality rules - tested where it is, in the bucket; nothing is copied. In `task acceptance` it runs after the features, on the events the scenarios published, every one of which must have landed. `ENV=aws task data:test` tests the last two days of the deployed stack's data (`DATA_DAYS`), each day by itself, so a rule about the whole - an `id` that repeats - is held within a day |

## Reading the data

| Task | What it does |
| --- | --- |
| `task data:query -- "select * from beer_rated"` | Runs SQL through DuckDB. Each event has a view, named after its schema object, that shows every event once; `data` is a struct (`data.score`) and `dt` the day it arrived. With no SQL it opens DuckDB's shell |
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
| `<name>-data-delivery` | Firehose failed to write to S3 in 5 minutes | Events are published but not being kept |
| `<name>-data-freshness` | The oldest event not yet in S3 is older than the contract's `latency` | The data is staler than promised |
| `<name>-data-rule` | The bus could not hand an event to Firehose in 5 minutes | Events are published but not reaching the stream |

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

1. The rule is `<name>-data`; its role is `<name>-data`. **Usually** the
   role or the stream was changed or removed outside Terraform.
2. `task deploy` puts them back; replay the gap from the bus's archive.
