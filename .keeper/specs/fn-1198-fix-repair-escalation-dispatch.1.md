## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Investigation-first: determine which gate dropped all three incident candidates, then fix that confirmed gate. The candidate path is: plan block writes state → sweep selects pending escalation rows → reads the task's blocked reason → parses the category prefix → routes SHARED_BASE_BROKEN to repair → resolves the repo token → fingerprints → dispatches one repair session per (repo, fingerprint). Top hypothesis (three-for-three silent drops suggest one common gate): the sweep's reason-read expects a key/path the plan writer does not produce, so the category parse gets null and routes to surface-and-stop. Verify by diffing the plan store's write-side (what `keeper plan block --reason` actually persists, and where) against the sweep reader's expectations — reproduce with a real block on a sandboxed board rather than trusting either side's code comments. Also check the two state-shaped alternatives before committing: a pre-set dispatch marker parking the rows, and escalation-cap starvation during the window. Fix the confirmed gate; the regression test must round-trip through the real writer and real reader (mocking the reason-read would paper over exactly this bug class).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:9866 — selectRepairCandidates: the ~6 silent-drop gates (runtime_status, reason-read null, category route, empty repo token)
- src/daemon.ts:9119 — readTaskBlockedReason: reads `blocked_reason` from <projectDir>/.keeper/state/tasks/<taskId>.state.json — diff against the plan store write-side (referenced from src/plan-worker.ts:480)
- src/daemon.ts:785 parseBlockedCategory, :828 routeBlockedCategory, :726 selectPendingBlockEscalations, :841 effectiveBlockEscalationRepo
- src/daemon.ts:9998 runRepairEscalationSweepTick — pause gate + ~60s interval; :9911 dispatchEscalationSession (global cap + per-key occupancy)
- test/daemon.test.ts:3952,4027 — the injected-deps sweep test pattern to extend (runRepairEscalationSweep imported at :104)

**Optional** (reference as needed):
- src/failure-fingerprint.ts:74 — fingerprintFailure (reuse; do not re-derive)
- src/derivers.ts:25-53 — repair key-shape validator; src/reducer.ts:4916 — RepairDispatched folds (existing; avoid fold changes)
- Incident block events in keeper.db: ids 4905460, 4912298, 4912637 (full block commands + reasons)

### Risks

- Pre-committing to the key-mismatch hypothesis risks fixing the wrong seam — confirm with a live write→read reproduction before editing.
- The escalation-guard role marker (KEEPER_ESCALATION_ROLE) must stay emitted on any dispatch-path change.

### Test notes

Extend the injected-deps sweep suite: a sandboxed board (sandboxEnv all six state classes) where a real `keeper plan block` write is followed by the sweep's real reason-read, asserting a repair dispatch decision for a SHARED_BASE_BROKEN reason and no dispatch for a non-repair category. Keep it in the fast pure tier — injected dispatcher, no real daemon/git/tmux.

## Acceptance

- [ ] Root cause named and documented in the Done summary with the confirming evidence
- [ ] A SHARED_BASE_BROKEN-blocked task on an unpaused board yields a repair dispatch decision within one sweep invocation at the pure seam
- [ ] The regression test round-trips a real plan-state block write into the sweep's real reader (no mocked reason-read) and is green
- [ ] Non-repair block categories still route unchanged (no over-dispatch regression)
- [ ] keeper fast suite green

## Done summary

## Evidence
