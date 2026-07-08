## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/exec-backend.ts, src/dispatch-failure-key.ts, test/autopilot-worker.test.ts, test/exec-backend.test.ts

### Approach

Move slot authority from pane cosmetics to the job lifecycle the daemon already proves: when the exit-watcher has verdicted a session dead (its job row is stopped/killed), the slot-occupancy gate must treat that slot as reclaimable and the slot-reclaimed reaper must be able to kill the residual pane — even though the pane's foreground command shows a live wrapper shell or launcher process. Preserve the deliberate pane-persistence UX: a pane may linger for `keeper tabs restore` inspection, but a lingering pane whose session is dead must never block a re-dispatch (the reaper reclaims it when the slot is actually needed, or after a bounded grace). Keep the pane-kill path safe: bounded, no shell interpolation of pane metadata, and never kill a pane whose job the daemon still considers live. Decide in-code whether the reaper's kill is immediate-on-need or grace-aged; document the choice.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/exec-backend.ts:160-181 — PaneInfo and the currentCommand-based occupancy contract being replaced/augmented; :381-382,579-580 — remain-on-exit inheritance and the wrapper's trailing interactive-shell tail; :525-541 — batched list-panes capture
- src/autopilot-worker.ts — the slot-occupancy gate and the slot-reclaimed reaper (locate by the slot-reclaimed reason key)
- src/dispatch-failure-key.ts — slot-occupied / slot-reclaimed reason prefixes and display kinds
- src/exit-watcher.ts:1-55 — the lifecycle verdict source (jobs working/stopped candidates, synthetic Killed folds)

**Optional** (reference as needed):
- src/agent/tmux-launch.ts:783-811 — wrapper construction (do NOT change the wrapper in this task; the tail is deliberate)
- docs/adr/0013 — sentinel/lifecycle discipline

### Risks

- Killing a pane for a session the projection wrongly considers dead would destroy a live worker — the gate must require the exit-watcher's proven verdict (kill_reason stamped), not a mere stopped read.
- The `keeper tabs restore` inspection flow must survive: reclaim on need or bounded grace, never eager blanket kills.

### Test notes

Pure-seam tests in the autopilot-worker suite: a reconcile snapshot with a dead-session job + a live pane showing a wrapper command asserts the slot reads reclaimable and the reaper decision targets the pane; a live-session job with the same pane shape asserts no reclaim. No real tmux — decisions through the injected pane/list seams.

## Acceptance

- [ ] A slot whose session the daemon has proven dead no longer blocks dispatch, even when its pane's foreground command is a live wrapper process
- [ ] The reaper never targets a pane whose job lacks a proven-dead verdict
- [ ] Pane metadata is never shell-interpolated into any kill invocation
- [ ] keeper fast suite green

## Done summary

## Evidence
