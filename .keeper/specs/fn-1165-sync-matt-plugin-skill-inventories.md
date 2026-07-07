## Overview

The matt plugin (arthack) ships five user-invoked skills, but two front-door
inventories were written early in the source epic and never resynced as later
tasks added skills, so both undersell what the plugin actually offers. Because
every matt skill is `disable-model-invocation: true`, human awareness is the
only invocation path — an incomplete inventory directly costs discoverability.
This is a docs-only sync: bring both enumerations up to the full five-skill set.

## Acceptance

- [ ] The `matt` entry in `claude/CLAUDE.md` lists all five shipped skills.
- [ ] The `## Skills` section in `claude/matt/README.md` lists all five shipped skills.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | claude/CLAUDE.md:36 Shipped line enumerates 3 of 5 matt skills; omits improve-codebase-architecture and init |
| F2 | kept | .1 | claude/matt/README.md:28-33 Skills section lists 4 of 5; omits init |

## Out of scope

- The README sync log's omission of `init` — correct as-is, since the log tracks forks only and `init` is an original skill.
- Any change to the skills themselves; this is inventory documentation only.
