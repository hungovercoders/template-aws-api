# Changelog

Every change merged into the template's default branch, newest first. Written by
`task changelog:generate` from the history; `task changelog:check` keeps it current.

## 2026-11-21

### Features

- the worked example is kept on main as overlays, one per step, not as branches ([#134](../../pull/134))
- task resources lists what a stack is made of, local or deployed ([#132](../../pull/132))
- a write-nfrs skill captures the non-functional requirements, each in its one home ([#131](../../pull/131))
- SLOs in specs/slos (OpenSLO) set the API's alarms, held by task slo:check ([#130](../../pull/130))
- a changelog of the template, written from its history and held to it by a gate ([#129](../../pull/129))
- every log line is an OpenTelemetry log record, in the trace of what caused it ([#128](../../pull/128))
- a monthly cost budget the owner says, and the table's recovery held by a test ([#125](../../pull/125))
- an API's rate limit is in its contract, applied by API Gateway and proved by a scenario ([#124](../../pull/124))
- the raw JSON's query views read the last 2 days by default ([#123](../../pull/123))
- the raw JSON is kept 7 years by default, said in the data contract; fixes Parquet kept days, not years ([#121](../../pull/121))

### Fixes

- the s3-control emulator gap is told on a CI runner too ([#112](../../pull/112))
- the local stack runs on macOS as on Linux, and the README says how to set it up ([#111](../../pull/111))

### Documentation

- the skills are up to date, and their detail lives in references beside them ([#126](../../pull/126))
- the README shows the daily Parquet compaction, its diagram marks the optional parts ([#110](../../pull/110))

### Other

- The events kept as data are compacted daily into Parquet, held to the data contract; the bootstrap covers every data stream, the compactor and its schedule. ([#109](../../pull/109))

## 2026-11-20

### Other

- Contracts are versioned by file and one stack serves every live major; a per-API ruleset cannot weaken the house rules; Dependabot raises security fixes. ([#108](../../pull/108))

## 2026-11-17

### Fixes

- bound the deploy role, deploy what the gates built, and a stage check that is green on every branch ([#107](../../pull/107))

## 2026-11-16

### Documentation

- what a fresh agent found missing from the implement skill ([#104](../../pull/104))
- the README recording gives the S3 query a screen of its own ([#101](../../pull/101))
- the README recording ends by querying the event in S3 ([#98](../../pull/98))
- the spec and implement skills cover every contract ([#95](../../pull/95))

## 2026-11-15

### Features

- a task says which emulator gaps are still there when the pin moves (#47) ([#88](../../pull/88))
- the data is tested and read where it is, never from a kept copy ([#77](../../pull/77))
- every AWS resource is tagged with its domain, team, service and repo (#58) ([#74](../../pull/74))
- events as data - landed in S3 under an ODCS data contract (#39) ([#69](../../pull/69))
- publish events through an outbox to EventBridge (#38) ([#66](../../pull/66))

### Documentation

- the README reads as a product page ([#92](../../pull/92))
- the documentation says what is now true (#80) ([#81](../../pull/81))

### Chores

- offer the skill for the new EventBridge custom event bus (#84) ([#85](../../pull/85))

## 2026-11-14

### Features

- the skills and contributing guide cover the API's whole life (#23)
- once there is a spec, the README describes the API, not the template (#22)
- lock the skeleton, test it on main, and report the contract version (#13, #14, #15)
- write-spec skill, and a gate that versions contract changes (#11, #12)
- generate the route table and scaffold operations and steps from the specs
- explore the API by hand with .http files and httpYac (#9)
- standard alerting in the skeleton (#8)
- authentication in the skeleton, driven by the contract's security (#2)
- structured logging, CORS, Renovate, licence and current Actions
- task mock serves the contract with Prism in the spec phase
- two generic indexes on the template's table
- pin AWS Emulator and add opt-in deployment to your AWS account
- test the shipped bundle on infra applied to AWS Emulator
- lint the contract with Spectral to lower snake_case house rules
- BDD and contract driven Lambda API template

### Fixes

- the compatibility gate sees changed behaviour, not only a changed contract (#24)
- close the gaps the second skill run found
- install oasdiff from its GitHub releases
- commit the generated .http requests and check they match the contract
- let the shell expand the .http file glob for task http
- show the Terraform apply against AWS Emulator in the task output

### Documentation

- implement-api covers what a fresh run found when catching up with a changed spec (#24)
- the example branches keep their own README when main's changes
- AGENTS.md holds the agent instructions; CLAUDE.md imports it (#21)
- conventional files where a convention exists (#21)
- a short README, five guides, an alarm runbook, and a gate that keeps them small (#17-#20)
- the generate-first principle in the README
- generate before you write, as a principle
- close the gaps a fresh run of the implement-api skill found (#1)
- how to merge starter contract changes into the example branches
- example error bodies in the starter contract, for a realistic mock
- record how the template and example branches relate
- describe the acceptance stack and how close it is to production
- state the branch's CI status at the top of the README
- bring your own business logic

### Chores

- ignore agent worktrees
- ruleset protecting the template and example branches

### Other

- Async input: an API takes messages from an SQS queue ([#62](../../pull/62))
- Every message is a CloudEvent ([#57](../../pull/57))
- An AsyncAPI contract in specs/, held to the same gates as the OpenAPI one ([#54](../../pull/54))
- Optional components an API can remove and restore ([#51](../../pull/51))
- AWS's skills are in the repository and stay current; an API adds its own ([#48](../../pull/48))
- Pin schemathesis exactly and let Renovate move it ([#44](../../pull/44))
- skill: tell SDK errors by name when the function runs on the emulator's runtime (#26)
- stack: when a run fails, show the errors the Lambda logged before the end of its log (#26)
- hooks: task check runs the fast gates for the stage the repository has reached (#27)
- stack: features and fuzz run through AWS Emulator's API Gateway and Lambda; the stand-in is gone (#26)
- hooks: a pre-push hook that runs the fast gates (#27)
- gate: every response the contract documents is returned to a scenario (#25)
- Initial commit
