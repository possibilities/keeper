## Overview

The pairctl retirement removed the `pairctl` CLI and its package, but two
arthack docs still instruct agents to invoke it: the design-taste synthesis
prompt and the install-orchestrator doc. This follow-up sweeps that residual
docs-drift so a documented workflow no longer dead-ends at a deleted command.

## Acceptance

- [ ] No arthack doc instructs an agent to run a `pairctl` subcommand
- [ ] The design-taste synthesis step points at the keeper replacement (`keeper pair send`) or drops the pairctl-specific guidance

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | improve-taste.md:366,379-380,384,435 invoke deleted pairctl send-message/list-models; design-taste synthesis flow breaks at Step 2 with command-not-found |
| F2 | merged-into-F1 | .1 | F2 (scripts/CLAUDE.md:3 stale "pairctl prompts" install step) shares F1's arthack docs-drift root cause; folded into F1's task |
| F3 | culled | — | NOTICES:206-207 stale license-attribution stub for a deleted package; no user impact, no surprise, no compliance risk |

## Out of scope

- NOTICES:206-207 attribution stub (F3, culled — harmless over-attribution, no compliance or reader impact)
- Any keeper-repo change (all surviving drift is arthack docs)
