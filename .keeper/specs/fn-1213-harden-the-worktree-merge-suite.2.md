## Description

From audit finding F7: the production merge-suite gate runs INLINE on the
single-flight reconcile drive. Evidence path: `runMergeSuiteGate` is wired as
the finalize probe at src/autopilot-worker.ts:7752 (`runMergeSuite: (a) =>
runMergeSuiteGate(a)`), reached via runReconcileCycle -> finalizeEpic. With
MERGE_GATE_INSTALL_TIMEOUT_MS (~10min) + MERGE_GATE_SUITE_DEADLINE_MS (~15min)
per package, a green finalize can block the reconcile loop ~25min (root) to
~50min (root + plugins/plan), during which autopilot dispatches nothing,
finalizes no other epic, and runs no recover/escalation pass board-wide. Green
is never pre-cached, so this cost is paid on EVERY successful worktree-mode close.

REFUTED sub-concern (do not chase it): a mid-suite `fatalExit`+respawn cannot
happen. The serve-liveness watchdog (`decideServeLivenessWatchdog`,
src/daemon.ts:3512) escalates only on (a) accept-stall of a real-read probe on
the serve SOCKETS (a separate serve-worker thread) and (b) main-loop
event-loop-delay p99 lag. A reconcile cycle blocked in `await runMergeSuiteGate`
inside the autopilot WORKER thread stalls neither the serve sockets nor the
main event loop (it awaits async git subprocesses). So this task is scoped to
liveness ISOLATION, not crash-safety.

Fix direction: run the gate off the reconcile drive in a dedicated worker,
mirroring how the baseline runner (src/baseline-worker.ts) already isolates
suite runs off the main drive — the established in-repo pattern fn-1204 did not
follow. If isolation is rejected on design grounds, instead DOCUMENT the inline
block as an accepted opt-in tradeoff (worktree mode is default-OFF) in the
relevant ADR / code rationale so the next reader is not surprised.

Files: src/autopilot-worker.ts (finalize gate wiring ~7752, runMergeSuiteGate:5073),
src/baseline-worker.ts (reference isolation pattern), src/daemon.ts (worker spawn site if a dedicated worker is added).

## Acceptance

- [ ] A green worktree-mode close no longer blocks board-wide dispatch/recover/escalation for the suite's duration, OR the inline block is documented as an accepted tradeoff with rationale
- [ ] The suite still runs OUTSIDE the commit-work flock and derives the identical deterministic merged OID
- [ ] `bun test` stays green

## Done summary

## Evidence
