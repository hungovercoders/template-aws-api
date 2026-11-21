<!-- api:start - generated from the contracts in specs/ by `task readme:generate`. Change a contract, not this block. -->
# Beer Catalogue API

A brewery's beer catalogue. Signed-in staff add the beers they brew, keep the details current and retire beers. Anyone can browse the catalogue, and drinkers rate beers from 1 to 5.

**Versions** [v0](specs/openapi.v0.yaml) (0.2.0) at `/v0` · [behaviour](specs/features) · [try it](http/contract.http)

## Operations

| Operation | Request | Caller | What it does |
| --- | --- | --- | --- |
| `list_beers_v0` | `GET /v0/beers` | Anyone | List the beers in the catalogue |
| `create_beer_v0` | `POST /v0/beers` | Signed in | Add a beer to the catalogue |
| `get_beer_v0` | `GET /v0/beers/{beer_id}` | Anyone | Fetch one beer |
| `retire_beer_v0` | `DELETE /v0/beers/{beer_id}` | Signed in | Retire a beer from the catalogue |
| `update_beer_v0` | `PATCH /v0/beers/{beer_id}` | Signed in | Change a beer's details |
| `rate_beer_v0` | `POST /v0/beers/{beer_id}/ratings` | Anyone | Rate a beer |

Messages and events have contracts of their own - [v0](specs/asyncapi.v0.yaml) (0.2.0) - with an [example of each](messages).

## Messages it receives

| Operation | On | What it does |
| --- | --- | --- |
| `receive_beer_rating_v1` | `beer-ratings` | Record a rating that was submitted elsewhere |

## Events it publishes

| Operation | On | What it does |
| --- | --- | --- |
| `publish_beer_created_v1` | `beer-events` | A beer was added to the catalogue |
| `publish_beer_updated_v1` | `beer-events` | A beer's details were changed |
| `publish_beer_retired_v1` | `beer-events` | A beer was retired from the catalogue |
| `publish_beer_rated_v1` | `beer-events` | A beer was rated |

## Events kept as data

Every event it publishes is also kept in S3, under a data contract - [v0](specs/datacontract.v0.yaml) (0.3.0): owned by the catalogue team, kept for 2 years, there to read within 15 minutes.
See [events as data](docs/data.md) for how it is tested and queried.

## Working on it

You need [mise](https://mise.jdx.dev) and, on macOS, Docker Desktop running.
Run `mise trust && mise install` once. Then `task dev` keeps the API running
on AWS Emulator in one terminal, and the tasks below talk to it from another.
`task ci` starts an emulator of its own: stop `task dev` first, or run
`EMULATOR_PORT=9298 task ci` ([running it locally](docs/testing.md#aws-emulator)).

| Task | What it does |
| --- | --- |
| `task dev` | Run the API on AWS Emulator; prints its URL and a token |
| `task http` | Send it the requests in `http/contract.http` |
| `task mock` | Serve the contract as a mock, with nothing implemented |
| `task queue:send -- <message>` | Send it one of the example messages in `messages/` |
| `task events:tail` | Follow the events it publishes |
| `task data:query -- "<sql>"` | Query the events kept in S3, a view for each |
| `task ci` | Every gate, in order: the definition of done |

What this API does is decided by its spec. To change it, change the
contract and the feature files ([the spec](docs/spec.md)); the gates then say
when the code has caught up ([testing](docs/testing.md)). See also
[deploying](docs/deploying.md) and the [runbook](docs/runbook.md) for its alarms.

Built on [template-aws-api](https://github.com/hungovercoders/template-aws-api), a BDD and contract driven template
for AWS Lambda APIs: the skeleton is the same for every API, and only the
spec and the behaviour behind it are this API's own.
<!-- api:end -->

## Notes

> **This is the `example/spec` branch of
> [template-aws-api](../../tree/main): the template plus a complete spec.**
> The contract and feature files above are the whole requirement. Nothing is
> implemented yet, so **CI is red on purpose** - `task ci` stops at
> `test:unit`, listing the six operations and the one message that have
> no file. Running
> `/implement-api` here produces
> [`example/implementation`](../../tree/example/implementation).
>
> Everything above this note was written by `task readme:generate` from the
> contract: this is what a repository's README becomes once it has a spec.
