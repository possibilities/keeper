## Overview

A `block_escalations` latch row terminally settled `attempted/skipped_category` (minted by a TOOLING_FAILURE block) stays latched after the task is re-parked under a different, escalatable category — producing ZERO escalation dispatches, while the `unblock::` dispatch collision guard still refuses the operator on the premise that autopilot may dispatch it (a premise the latch itself falsifies). Live evidence: fn-1358.1's AUDIT_READY re-park sat 50+ min with a dead orchestrator and no escalation; the operator needed `keeper dispatch unblock::… --force`. End state: a category change re-arms escalation, and the collision guard tells the truth when a latch precludes autopilot dispatch.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "select task_id,status,outcome from block_escalations;"` — after a category re-park, the row must leave its terminal outcome and escalate again.

## Acceptance

- [ ] A TOOLING_FAILURE-latched task re-blocked under an escalatable category escalates after grace, exactly once.
- [ ] `keeper dispatch unblock::<task>` never refuses on a premise the latch falsifies — it proceeds or names the latch.

## Early proof point

Task that proves the approach: `.1`. If it fails: keep the latch semantics, land only the collision-guard truthing plus a visible "latched, will not escalate" pill/log.

## References

- ~/docs/keeper-phase2-backlog.md item #50 (live evidence 07-18 23:3x, fn-1358.1)
