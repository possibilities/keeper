## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Extend computeSlotOccupancy (the existing slot reaper) with a new dead-classification arm
per ADR 0052: a job with state=stopped whose backend is derived-idle (live pane, turn
ended) past an injectable grace, holding a slot another dispatch wants, is reclaimed via
the existing reclaimSlotPane→killWindow path. Do NOT fork isStoppedJobLive or any shared
occupancy predicate — the slot releases when the pane actually dies, keeping board
display, escalation-cap accounting, and autoclose byte-consistent. A working session is
never reclaimable (existing fail-safe test stays green). The arm inherits: a per-sweep
blast cap (mirror autoclose), the null-livePaneIds conservative fallback (unknown→alive),
a startup grace (a never-started row — active_since null — is not idle), and pane-identity
re-verification at kill time (never signal a re-looked-up bare pid; reuse
src/proc-starttime.ts discipline where processes are touched). The occupied-reason string
must stay stable across cycles (no growing age text) so the producer change-gate
suppresses re-emits.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:1784 — computeSlotOccupancy; the dead criterion at :1833 (graceElapsed && (provenDead || bare-shell)) this arm extends
- src/reconcile-core.ts:1683 — SLOT_RECLAIM_GRACE_SEC + :1832 graceElapsed-from-updated_at idiom
- src/reconcile-core.ts:1659 — isStoppedJobLive (read-only context: why an idle claude occupies today; do not modify)
- src/autopilot-worker.ts:3775 — reclaimPaneId application; :8271 wiring to paneOps.killWindow
- src/autoclose-worker.ts — the separate done-and-idle reaper + its blast cap; confirm remit disjointness, do not modify its behavior

**Optional** (reference as needed):
- src/types.ts — Job fields state/updated_at/active_since/worker_phase/backend_exec_pane_id (idleness is derived; no new column)
- src/proc-starttime.ts — pid+start-time identity helper
- test/autopilot-worker.test.ts:1056 — the slotInput() suite; working-is-healthy at :1192

### Risks

- Double-kill race with autoclose: benign only because killWindow no-ops on a dead pane —
  verify that, and confirm what bumps a stopped job's updated_at (a heartbeat that bumps it
  would make the grace never elapse — the defect would silently persist).
- Reclaiming a session about to resume: the grace plus wantsDispatch scoping is the guard;
  never widen to slots nobody wants.

### Test notes

Extend the slotInput suite: stopped+idle-pane past grace + wanted slot → reclaim; within
grace → occupied; active_since null → never reclaimed; working → never; degraded inputs
(task 1) → arm inert; blast cap honored across a many-zombie sweep.

## Acceptance

- [ ] A stopped, backend-idle keeper session past the grace on a wanted slot is reclaimed automatically and the slot dispatches
- [ ] working sessions, never-started rows, within-grace rows, and degraded-input ticks are never reclaimed
- [ ] A per-sweep blast cap bounds reclaims and the occupied-reason stays cycle-stable
- [ ] No shared occupancy predicate is forked; existing occupancy/board/autoclose tests stay green

## Done summary

## Evidence
