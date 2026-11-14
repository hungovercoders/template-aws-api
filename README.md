<!-- api:start - generated from specs/openapi.yaml by `task readme:generate`. Change the contract, not this block. -->
# Beer Catalogue API

A brewery's beer catalogue. Signed-in staff add the beers they brew, keep the details current and retire beers. Anyone can browse the catalogue, and drinkers rate beers from 1 to 5.

**Version 0.1.0** · [contract](specs/openapi.yaml) · [behaviour](specs/features) · [try it](http/contract.http)

## Operations

| Operation | Request | Caller | What it does |
| --- | --- | --- | --- |
| `list_beers` | `GET /beers` | Anyone | List the beers in the catalogue |
| `create_beer` | `POST /beers` | Signed in | Add a beer to the catalogue |
| `get_beer` | `GET /beers/{beer_id}` | Anyone | Fetch one beer |
| `retire_beer` | `DELETE /beers/{beer_id}` | Signed in | Retire a beer from the catalogue |
| `update_beer` | `PATCH /beers/{beer_id}` | Signed in | Change a beer's details |
| `rate_beer` | `POST /beers/{beer_id}/ratings` | Anyone | Rate a beer |

Messages and events are version 0.1.0 of [their own contract](specs/asyncapi.yaml), with an [example of each](messages).

## Messages it receives

| Operation | On | What it does |
| --- | --- | --- |
| `receive_beer_rating` | `beer-ratings` | Record a rating that was submitted elsewhere |

## Working on it

| Task | What it does |
| --- | --- |
| `task dev` | Run the API on AWS Emulator; prints its URL and a token |
| `task http` | Send it the requests in `http/contract.http` |
| `task mock` | Serve the contract as a mock, with nothing implemented |
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
> `test:unit`, listing the six operations that have no file. Running
> `/implement-api` here produces
> [`example/implementation`](../../tree/example/implementation).
>
> Everything above this note was written by `task readme:generate` from the
> contract: this is what a repository's README becomes once it has a spec.
