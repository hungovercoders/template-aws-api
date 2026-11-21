---
name: write-nfrs
description: Work with the API's owner to capture its non-functional requirements - how long its data is kept, how fresh and how sensitive it is, how fast a caller may call, how available and how quick it must be, how it recovers and what it may cost - each written once, into the one home the template acts on and tests: the data contract, the OpenAPI contract, specs/slos (OpenSLO) or the owner's infra settings. Use when write-spec reaches them, and whenever one of them changes. Ends with the gates of every home green and each requirement traced to what proves it; it does not implement.
---

# Write the non-functional requirements with the owner

A non-functional requirement is only worth having if something enforces it.
In this template each one has **one home**, a file the stack is built from,
and a gate, a test or an alarm that holds the API to it. Your job is to get
the owner's answer into that home - never a second copy in prose, a README
or a ticket, where it would drift from what is deployed.

The owner decides every value. Ask, propose a default with its reason, and
write only what they confirm. A requirement they cannot answer yet stays at
the template's default, and you say so in the summary.

## The requirements and their homes

| Requirement | Home | Proven by |
| --- | --- | --- |
| How long the raw JSON (the audit copy) is kept | data contract: the `production` server's `customProperties` `retention` (ISO 8601, `P7Y` default, at least `P7D`) | `data:check`; the bucket's lifecycle rule, planned in `infra/tests/data.tftest.hcl` |
| How long the Parquet is kept | data contract: `slaProperties` `retention` (`value`, `unit: d` or `y`) | `data:check`, the same plan test |
| How fresh the data is | data contract: `slaProperties` `latency` | `data:check`; the compaction schedule |
| How sensitive each property is | data contract: each property's `classification` | `data:lint` (`rules/datacontract.yaml`) |
| How fast a caller may call | each `specs/contracts/openapi.v<N>.yaml`: root `x-rate-limit {requests_per_second, burst}`, `429` on every operation | `spec:check`; a scenario using `this.flood()` against the real stack; `infra/tests/http.tftest.hcl` |
| How available the API is | `specs/slos/<name>.yaml`: an availability SLO (`5xx` over `Count`, `target`) | `slo:check` (`oslo validate`); the `api-5xx` alarm in production |
| How quick the API, or one operation, is | `specs/slos/<name>.yaml`: a latency SLO (a percentile, `op: lte`, `value` in ms; `metadata.labels.operation` for one operation) | `slo:check`; the `api-latency` or `latency-<operationId>` alarm |
| How it recovers | fixed by the template: point-in-time recovery, any second of the last 35 days (`docs/runbook.md#restore-the-table`) | `infra/tests/owner.tftest.hcl` |
| What it may cost a month | `infra/budget.auto.tfvars.json`: `monthly_budget_usd` | `infra/tests/owner.tftest.hcl`; the budget's alerts at 80% spent and 100% forecast |
| Who owns it | `infra/tags.auto.tfvars.json`: `domain`, `team` | `tags:check` |

The data contract rows exist while the repository has the `data` component
(`task component:list`); without it, skip them. Anything the owner asks for
that has no home here - an uptime promise to a customer, a security
certification, a support rota - is not something this template can enforce:
say so, and suggest where it belongs (a contract with the customer, the
`aws-observability` skill for alarms beyond these) rather than inventing a
home for it.

## Workflow

1. **Find what is already said.** Read each home above. Do not ask again
   about a requirement that is written; play it back instead.
2. **Ask about each missing one, with a proposal.** One topic at a time:
   - **Data** - follow the data part of the `write-spec` skill
     (`.claude/skills/write-spec/data.md`): retention of both copies,
     freshness, classification. Ask what law or policy applies to personal
     data before proposing a retention.
   - **Rate limit** - how many requests a second one caller should make, and
     how many at once. Propose what the busiest real client needs, with
     headroom; say that beyond it callers get `429`. One limit per major.
   - **Availability** - what share of requests may fail with a server error.
     Propose `0.999` (about 43 minutes of errors in 30 days) and say what a
     higher target costs: every nine is ten times stricter.
   - **Latency** - how long the slowest answers may take, at which
     percentile: `p99` within the time a caller waits before giving up.
     Ask whether one operation is slower by nature (a search, a payment)
     and deserves an SLO of its own; never one per operation by default.
   - **Recovery** - the template keeps 35 days restorable and the raw JSON
     for its retention. Ask whether that is enough; if it is not, it is a
     change to the template, not to this API.
   - **Cost** - what the stack may cost a month, in US dollars. Never guess
     one; the budget alerts at 80% spent and at 100% forecast.
3. **Write each answer into its home**, and nowhere else:
   - an SLO is a file of its own, named after its `metadata.name`, in the
     shape `docs/spec.md` (Rate limits and service levels) shows;
   - a contract change follows that contract's versioning: `task
     spec:compat` and `task data:compat` say what `version` it needs;
   - a rate limit needs its scenario (`write-spec`), and `implement-api`
     makes it pass.
4. **Run the gates of every home you wrote**, and fix what they report:
   `task slo:check`, `task spec:check`, `task spec:lint`, `task spec:compat`,
   `task data:lint`, `task data:check`, `task data:compat`, `task tags:check`,
   `task infra:validate`.
5. **Summarise for the owner**: each requirement, its value, its home and
   what proves it (the table above, filled in), and which ones stayed at the
   template's default because they did not say. Get their approval.

## Changing one

A changed requirement is a change to its home, made the same way and proven
by the same gate. Say what the change does when deployed: a shorter
retention deletes data older than it; a lower rate limit refuses callers
who were served; a stricter SLO alarms on what was quiet. Shortening
retention or lowering a limit is a breaking change for someone - the
owner's decision, never yours.
