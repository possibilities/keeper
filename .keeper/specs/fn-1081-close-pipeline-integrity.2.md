## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/autopilot-worker.ts, src/dispatch-failure-key.ts, test/autopilot-worker.test.ts, test/dispatch-failure-key.test.ts

### Approach

Make a slot held by a dead job visible, and reclaim it only when provably dead. The
occupancy predicate today treats any stopped job with a live pane as occupying
(isStoppedJobLive, reconcile-core.ts:970-982) — but the launcher wrapper's trailing shell
keeps the pane alive after claude dies, so dead and resumable are indistinguishable by pane
existence. Extend the snapshot probe (loadReconcileSnapshot, autopilot-worker.ts:3831-3844 —
producer-side, never a fold) to capture the pane's current foreground command; deadness
criterion = job state=stopped AND pane foreground process is a bare shell (the exec-shell
tail signature) AND a grace age threshold. When a key's mint is blocked by an occupying job
that meets the criterion: auto-reclaim (kill the pane/window, release the slot) and emit a
DispatchFailed reason (e.g. close-slot-reclaimed) through createDispatchFailedGate; when
blocked by an occupying job that does NOT meet it (possibly resumable): emit a visible
slot-occupied reason through the gate, no kill. Auto-clear: fire the gate's noteClear /
DispatchCleared the cycle the occupying job is gone; scope the auto-clear to the new reason
prefix only — it must never touch a genuine close::<epic> conflict key. Add the new reasons
to dispatch-failure-key.ts display rules keeping prefixes collision-free (assertNever).

### Investigation targets

**Required** (read before coding):
- src/reconcile-core.ts:945-982 — isOccupyingJob/isStoppedJobLive; the criterion lands as new plain data on the snapshot, decision stays pure
- src/autopilot-worker.ts:3831-3844 — livePaneIds probe to extend (tmux pane_current_command); :922-945 the change-gate contract
- src/exec-backend.ts:316-324 — the wrapper exec-shell tail this detects
- src/dispatch-failure-key.ts — display rules + prefix constraints

### Risks

- Killing a resumable session is the catastrophic failure — the criterion must be conservative; when in doubt, visibility only. The pure decision function must be exhaustively tested on the live/dead/ambiguous matrix.
- Re-fold determinism: all liveness data enters via the snapshot; reconcile stays pure; refold-equivalence green.

### Test notes

Extend autopilot-worker.test.ts isOccupyingJob coverage (:583-699) with foreground-command
cases; gate tests: emit-once, reason-change, clear-on-gone; pill test for the new reasons.

## Acceptance

- [ ] Dead-claude slot-hold mints a visible reason within one cycle; provably-dead gets reclaimed; ambiguous stays visible-only
- [ ] Auto-clear fires when the occupier is gone, scoped to the new reason prefix; conflict keys untouched
- [ ] All emits route the change-gate (O(1) per condition); refold-equivalence green

## Done summary

## Evidence
