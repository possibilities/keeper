## Overview

The DB-derived crash-restore burst heuristic keys its contiguous-cluster
signature on `jobs.last_event_id`, treating it as the Killed event's rowid.
That column is actually a generic "last fold that touched this row" value;
the burst signature stays correct only because terminal guards in the reducer
make any post-kill fold a no-op and the restore-worker prunes killed jobs from
the window-index cache. That invariant is real and load-bearing but is enforced
remotely and asserted nowhere — a future late-stamping fold without a terminal
guard would silently corrupt restore membership for unknown/legacy-NULL rows.
This adds a guard test that pins the invariant.

## Acceptance

- [ ] A test asserts a killed row's burst position (its `last_event_id` key) is
      unchanged by a subsequent unrelated fold targeting that row.
- [ ] The test fails if a post-kill fold moves a killed row's burst signature.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | restore-set.ts:190-308 burst keys on the generic `last_event_id` column; the no-post-kill-fold invariant is enforced only by remote terminal guards the code cannot show locally, so a guard test pins it. |
| F2 | culled | — | Operator nicety on a dry-run-default recovery script; double-dispatch guidance already lives in `--help` and the dropped probe was an intentional daemon-down-first tradeoff. |
| F3 | culled | — | Auditor itself states the open-failure `die()` gap does not block shipping; it is already exercised indirectly. |

## Out of scope

- Restoring a runtime autopilot-unpaused warning to restore-agents.ts (F2, culled).
- Explicit open-failure `die()`-path coverage (F3, culled).
