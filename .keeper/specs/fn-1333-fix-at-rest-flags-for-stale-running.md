## Overview

The stale-running count split narrowed `epicTally.running` so stale-running
epics no longer increment it, but the `atRest` predicate in `cli/status.ts`
was not updated to account for the new `stale_running` partition. As a
result `keeper status` — the repo's designated board-orientation surface —
now reports a board whose only occupancy is stale-running epics as
`drained: true` / at-rest, contradicting ADR 0083's framing of stale-running
as a conservative hold that cannot establish work is currently active. This
is a display-flag correctness fix plus the coverage that would have caught it.

## Acceptance

- [ ] `atRest` (and thus `drained`/`jammed`) accounts for `stale_running` epics
- [ ] A board whose only occupancy is stale-running epics reports `drained: false`
- [ ] A test pins the atRest/drained/jammed interaction with `stale_running`

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/status.ts:432-433 atRest reads only epicTally.running===0 while tallyVerdicts routes stale-running rows to stale_running, so a board with only stale-running epics regresses to drained:true. |
| F2 | merged-into-F1 | .1 | F2 (test gap: atRest/drained/jammed x stale_running untested) is the acceptance test for F1's fix; merged into F1's task rather than standing alone. |

## Out of scope

- `keeper await drained` behavior (unaffected: holds on any non-completed verdict tag; stale-running is tag `running`)
- Autopilot readiness gating (reads readiness directly, not the display flags)
