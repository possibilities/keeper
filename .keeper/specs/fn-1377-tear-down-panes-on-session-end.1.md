## Description

**Size:** M
**Files:** src/daemon.ts, src/autopilot-worker.ts, src/agent/tmux-launch.ts, test/autopilot-worker.test.ts, test/reclaim.test.ts

### Approach

Give AUTOPILOT-DISPATCHED sessions' terminal transitions ownership of
their pane: when a board job (dispatch_origin autopilot; plan-verb
work/close/resolve/deconflict/repair/unblock) reaches ended, killed, or
autoclosed with a recorded backend_exec_pane_id, the producer plans a
pane teardown (kill the pane, shell included) within one bounded
window, decision-gated through a pure seam with injected pane/process
liveness. Add a bounded, capped periodic GC collecting terminal-state
AUTOPILOT panes missed across daemon restarts — mirror the occupancy
pass's conservative guards (working rows never candidates; degraded
probe inert; blast cap per sweep). HARD BOUNDARY, test-enforced: named
sessions, handoffs, free-form operator dispatches, manual and adopted
sessions are NEVER candidates in ANY state — the human keeps those tabs
deliberately; a stopped non-autopilot session is resting, not litter.
Panes without a keeper ownership record are never touched. Compose
beside fn-1375's stopped-session reap — teardown fires only on
TERMINAL states.

### Investigation targets

*Verify before relying — these file refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- jobs table: dispatch_origin + plan_verb + backend_exec_pane_id columns — the candidacy key; verify how free-form `keeper dispatch --prompt-file` sessions stamp dispatch_origin (they must NOT classify as candidates)
- src/reconcile-core.ts:2033 — computeSlotOccupancy's guards and the mint-driven bare-shell reclaim (the gap this fills)
- src/autopilot-worker.ts — reclaimSlotPane executor (near :4903) + reaper step pattern (:1770)
- src/agent/tmux-launch.ts — pane creation/ownership records
- fn-1375's landed changes on this surface (dep-sequenced behind it)

**Optional** (reference as needed):
- test/autopilot-worker.test.ts pure-seam table patterns
- ~/docs/keeper-phase2-backlog.md #64 entry — census, mechanism, and the mis-scoped sweep

### Risks

- Misclassifying a named/handoff/manual session as a candidate is the defect that already burned the human once — the candidacy predicate must be positive-evidence (autopilot origin + board verb), never inferred from state or pane appearance.
- Killing a pane whose job row is stale-working with a live agent: candidacy requires TERMINAL state AND no live agent child, re-verified at act time.
- Autoclose and operator-kill paths have partial teardown behavior — compose, don't double-kill.

### Test notes

Deterministic pure-seam tables with injected liveness; explicit
negative table rows for every non-autopilot session class. No real
tmux. Named gates only.

## Acceptance

- [ ] A terminal-state autopilot-dispatched job's keeper-owned pane is teardown-decided within one bounded window, shell included, table-tested through the pure decision seam.
- [ ] Every non-autopilot session class (named, handoff, free-form operator dispatch, manual, adopted) is proven a non-candidate in every job state by explicit negative tests.
- [ ] A live agent's pane is never a candidate; the GC is blast-capped, inert on a degraded probe, and requires a keeper ownership record.
- [ ] Existing occupancy/reap regression tables stay green; named focused gates and typecheck green.

## Done summary
Terminal autopilot job transitions (ended/killed/autoclosed) now own their tmux pane teardown through a pure decision seam (decideTerminalPaneTeardowns) requiring positive-evidence candidacy: autopilot dispatch_origin, board plan_verb, non-adopted tmux job, exact pane-owner stamp, and dead/recycled process. Panes are stamped with their exact keeper job id at launch (claude and pi paths), the pre-terminal pane coordinate survives onto the lifecycle event instead of being nulled, and a bounded periodic GC plus transition-driven sweep both funnel through the same seam, capped and inert on a degraded probe. Named/handoff/free-form/manual/adopted sessions are proven non-candidates in every state by explicit negative tests.
## Evidence
