# Skills for this API

Part of the `write-spec` skill: settle it before the user approves the spec (workflow step 8).

`skills.json` lists the skills in this repository. The template brings the
ones every API needs. What this API needs beyond them is the user's choice,
made once you know what the API does - settle it before step 8:

- **Offered by the template** (`offered` in `skills.json`). Each says when it
  earns its place. Tell the user which apply to this API and why, and add the
  ones they want: `task skills:add -- <name>`.
- **For what the API integrates with.** For each integration from workflow step 2, ask
  the user whether a skill or tool for it exists and should be added - the
  provider's own, their organisation's, or none. From a git repository:
  `task skills:add -- <name> --repository <url> --path <dir>`. One of their
  own, written into `.claude/skills/<name>/`: `task skills:add -- <name> --manual`.
- **Record every integration** in `integrations` in `skills.json`, with the
  skill chosen, or `null` and why. `/implement-api` reads it and does not ask
  again, and a later reader sees it was considered:
  `{ "name": "Stripe", "skill": null, "note": "none wanted; uses the REST API" }`.

Never add a skill the user has not agreed to: it is context every later
session carries. Never edit a copied skill - `task skills:check` fails if one
is. Ask the user to check a skill's licence allows the copy.
