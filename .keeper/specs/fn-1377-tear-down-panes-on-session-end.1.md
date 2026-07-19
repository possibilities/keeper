## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/agent/tmux-launch.ts, test/autopilot-worker.test.ts, test/reclaim.test.ts

### Approach

Give session terminal transitions ownership of their pane: when a job
reaches ended, killed, or autoclosed with a recorded
backend_exec_pane_id, the producer plans a pane teardown (kill the
pane, shell included) within one bounded window, decision-gated
through a pure seam with injected pane/process liveness so a live
agent's pane is never a candidate. Add a bounded, capped periodic GC
pass that collects terminal-state jobs' panes missed across daemon
restarts — mirror the occupancy pass's conservative guards (working
rows never candidates; degraded tmux probe leaves the pass inert;
blast cap per sweep). Panes not created by keeper (no recorded
ownership) are never touched. Compose beside fn-1375's stopped-session
reap — teardown here fires only on TERMINAL states, never on stopped.

### Investigation targets

*Verify before relying — these refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/reconcile-core.ts:2033 — computeSlotOccupancy's dead-classification arms and conservative guards (the pattern to mirror; the bare-shell reclaim that today runs only on mint contention)
- src/autopilot-worker.ts — reclaimSlotPane (the existing pane-kill executor to reuse, near :4903) and the reaper step pattern (:1770)
- jobs table lifecycle: backend_exec_pane_id + state transitions (terminal fold sites in src/reducer.ts; teardown is producer-side, folds stay pure)
- src/agent/tmux-launch.ts — pane creation/ownership records (what marks a pane keeper-owned)
- fn-1375's landed changes on this surface (your lane includes them — this epic is dep-sequenced behind it)

**Optional** (reference as needed):
- test/autopilot-worker.test.ts pure-seam table patterns (slotInput/zombieDecisionInput factories)
- Backlog #64 entry in ~/docs/keeper-phase2-backlog.md — census + mechanism

### Risks

- Killing a pane whose job row is stale-working with a live agent is the catastrophic case — candidacy requires TERMINAL job state AND no live agent child, both re-verified at act time.
- Autoclose and operator kills already have partial teardown paths — find and compose with them rather than adding a second killer for the same pane.
- Panes the human created or adopted must be structurally out of scope (keeper-ownership record required).

### Test notes

Deterministic pure-seam tables with injected liveness; no real tmux.
Named gates only.

## Acceptance

- [ ] A terminal-state job's keeper-owned pane is teardown-decided within one bounded window, shell included, and a live agent's pane is never a candidate — table-tested through the pure decision seam.
- [ ] The periodic GC collects terminal-state panes missed across a restart, is blast-capped, inert on a degraded probe, and never touches a pane without a keeper ownership record.
- [ ] Existing occupancy/reap regression tables stay green.
- [ ] The named focused gates and the typecheck are green.

## Done summary

## Evidence
