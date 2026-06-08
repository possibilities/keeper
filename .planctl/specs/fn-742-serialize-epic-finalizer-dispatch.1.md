## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/readiness.ts, test/autopilot-worker.test.ts, test/readiness.test.ts

### Approach

Prevent concurrent dispatch of `close::<epic>` and `approve::<epic>` for the
same epic. Preferred shape: an in-memory per-epic finalizer guard on
`ReconcileState` mirroring fn-735's `redispatchCooldown` — when a finalizer
(`close` or `approve`) for an epic is dispatched, stamp the epic id BEFORE the
confirm await; `reconcile` reads the stamp and suppresses dispatching the
OTHER finalizer for that epic until the first folds/clears; `driveCycle`
sweeps. Alternative (fallback): extend `applySingleTaskPerEpicMutex`
(readiness.ts:1447) so the `perCloseRow` epic-level slot is mutually exclusive
with its sibling approve. Whichever path: approve stays cap-exempt (fn-728) —
the gate is per-epic close↔approve only, never a blanket approve suppression
(or a pending-approval backlog deadlocks its own approvers).

### Investigation targets

**Required:**
- src/autopilot-worker.ts:1131-1172 — close-row dispatch site (no cross-verb guard)
- src/autopilot-worker.ts:188,340-373,548 — fn-735 `redispatchCooldown` Map +
  `isInCooldown`/`sweepRedispatchCooldown` + stamp site (the shape to mirror)
- src/readiness.ts:1447 `applySingleTaskPerEpicMutex` (perTask-only — the gap)
- src/autopilot-worker.ts:908-922 `dispatchKey` / `verbForVerdict` (approve→null
  for rejected); src/autopilot-worker.ts:955-958 `isOccupyingJob`
- test/autopilot-worker.test.ts:875,1167,1207 (per-epic mutex + fn-728 pins)

### Risks

- fn-728 approve-deadlock regression — gate must be per-epic, approve stays
  cap-exempt. Add a test that a pending-approval backlog still drains.
- Reconcile purity: new state on `ReconcileState`, read-only in `reconcile`,
  mutated only in `runReconcileCycle`/`driveCycle`.
- UNIT TRAP: unix-seconds throughout.
- Daemon-side; not live until kickstart.

### Test notes

- Pin: close and approve for the same epic don't both dispatch in one/adjacent
  cycles; the suppressed one fires after the first clears.
- Pin: approve backlog across DIFFERENT epics still drains (no deadlock).

## Acceptance

- [ ] `close::<id>` + `approve::<id>` for the same epic never dispatch
  concurrently; fold-lag-immune (in-memory).
- [ ] approve backlog across epics still drains (fn-728 preserved); reconcile
  stays pure; unit-seconds.
- [ ] Tests cover concurrent-finalizer suppression + the no-deadlock case.

## Done summary
Added an in-memory per-epic finalizer guard on ReconcileState (mirroring fn-735) that serializes close↔approve for the same epic: stamp the epic id at the close-row dispatch before the confirm await, suppress the sibling finalizer in pure reconcile, sweep in driveCycle. Keyed by epic id so one stamp covers both finalizer verbs; scoped to epic finalizers only (isEpicFinalizer flag) so task-level approve backlogs still drain (fn-728 preserved).
## Evidence
