## Overview

The autopilot reconciler dispatches an epic-level `close` and an epic-level
`approve` for the SAME epic with no mutual exclusion. On fn-740 (2026-06-08)
the `close` raced the `approve`, the close-side quality audit landed a bogus
`rejected` epic approval, and the epic stuck on the board as
`[::blocked:job-rejected]` with no way out. Two gaps: (1) the per-epic mutex
(`applySingleTaskPerEpicMutex`, src/readiness.ts:1447) serializes only
`perTask` rows — it does NOT cover the epic-level `perCloseRow` close/approve
slot; (2) the `{kind:"job-rejected"}` verdict resolves `verbForVerdict → null`,
so a rejected epic is non-dispatchable and has no clean board exit / re-approve
path. This epic serializes per-epic finalizers (close and approve for the same
epic never run concurrently) and gives a rejected epic a clean exit.

The serialization MUST stay fold-lag-immune (the race fires precisely in the
reducer-lag window), so it mirrors the fn-735 in-memory `redispatchCooldown`
shape on `ReconcileState` — stamp at dispatch BEFORE the confirm await, read in
pure `reconcile`, sweep in `driveCycle`. It MUST NOT re-introduce the fn-728
approve-deadlock: approve stays cap-exempt; the finalizer gate is per-epic
(close↔approve of the SAME epic), not a blanket approve suppression.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/readiness.test.ts`
- `bun test`
- `launchctl kickstart -k gui/$(id -u)/arthack.keeperd`  # deploy (operator)

## Acceptance

- [ ] For a single epic, `close::<id>` and `approve::<id>` are never dispatched
  concurrently — one completes (and its outcome folds) before the other is
  eligible. Fold-lag-immune (in-memory, not projection-read).
- [ ] A rejected epic has a defined board exit: it is no longer stuck
  `[::blocked:job-rejected]` with no recourse (re-approve path or auto-clear —
  decided in `.2`).
- [ ] approve is NOT globally suppressed/deadlocked — a pending-approval backlog
  still drains (fn-728 invariant preserved); the gate is per-epic close↔approve.
- [ ] Determinism + reconcile purity intact (state on `ReconcileState`, read-only
  in `reconcile`); unit-SECONDS throughout (no `*_TTL_MS` mixing). Tests cover
  the concurrent-finalizer suppression and the rejected-exit path.

## Early proof point

Task that proves the approach: `.1` (the per-epic finalizer serialization). If a
clean in-memory per-epic guard proves to interact badly with the existing
per-task mutex / approve-exemption, fall back to extending
`applySingleTaskPerEpicMutex` to cover the `perCloseRow` slot in readiness.

## References

- Incident: `~/docs/keeper-incident-2026-06-08-continuity.md` (fn-740 race).
- fn-735 (redispatch cooldown — the in-memory suppression shape to mirror),
  fn-728 (approve cap-exemption — the deadlock NOT to re-introduce), fn-721
  (`pending_dispatches` as readiness mutex), fn-703 (approval-pending git verdict
  holds mutex). All done — read their specs/history for mutex-evolution rationale.

## Best practices

- **Stamp the in-flight key BEFORE the await, not after** (k8s
  `UIDTrackingControllerExpectations`) — a post-await stamp leaves an uncovered
  cold-boot window. [practice-scout]
- **Don't read the projection to decide "already dispatched"** — it lags 15-60s;
  the in-memory map is the only fold-lag-immune arm. [fn-735]
- **Budget-exemption ≠ suppression-exemption** — keep approve cap-exempt but NOT
  finalizer-gate-exempt for its own epic. [practice-scout + fn-728]
- **UNIT TRAP:** reconcile `now` is unix-SECONDS; never mix with ms `*_TTL_MS`. [fn-735]
