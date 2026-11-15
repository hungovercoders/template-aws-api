# Specifying the events as data

Read this when the API publishes events and the user wants them kept - for
analysis, for other systems, for an audit. It adds to `SKILL.md`. The data
contract is `specs/datacontract.yaml` (`docs/data.md`).

If the user does not want the events kept, propose removing the component
(`task component:remove -- data`) and stop here.

## Workflow

1. Agree the events first: the AsyncAPI contract and its scenarios. The data
   is those events, so nothing here adds or changes one.
2. `task data:generate` starts the contract, or brings it up to date: a
   schema object for every published event, with each property's type and
   whether it is required. Never type those by hand, and never edit them -
   change the AsyncAPI contract and run it again.
3. Ask the user for what only they can say, and write it in. Propose an
   answer for each; never invent one:
   - **who owns the data** (`team`) and **what it is for**
     (`description.purpose`; `usage` and `limitations` if they have them);
   - **how sensitive each property is** - `classification`: `public`,
     `internal`, `confidential` or `restricted`. Go through the properties
     of `data` with them. Anything that identifies a person is at least
     `confidential`; ask whether it should be in the event at all;
   - **where it is kept** - the `production` server: the bucket's name
     (globally unique; propose `<org>-<api>-events`) and a prefix;
   - **how long it is kept** (`slaProperties`, `retention`) - ask what law
     or policy applies to personal data before proposing a number;
   - **how fresh it must be** (`slaProperties`, `latency`): how soon after
     an event happens a reader can rely on it being there;
   - **quality rules** the data must keep beyond its types - a count that
     is never zero, a value that is always one of a set. Each is tested
     against real data, so only rules that are always true;
   - **who else reads it** - other AWS accounts are a deploy variable
     (`data_reader_accounts`), not part of the contract;
   - optionally, **`context`**: how to use the data, for people and for AI
     readers. Offer it; nothing requires it.
4. `task data:lint`, `task data:check` and `task data:compat` must pass.
   Their messages say exactly what is missing.
5. Confirm the whole contract with the user, as for any spec.

## Changing it

A change to an event starts in the AsyncAPI contract and its scenarios;
`task data:generate` carries it here, and `task data:compat` then holds
`version` to it. Removing a property or changing its type breaks whoever
reads the data: that is the user's decision, and a new major version.
Retention, freshness and classification change here alone, with a new
version; shortening retention deletes data when it is deployed - say so.
