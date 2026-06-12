## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Make occupancy liveness-aware for the `stopped` arm of the dispatch dedupe. `isOccupyingJob` currently returns true for state working OR stopped; keep working as-is and gate the stopped arm on actual session liveness (the job's backend pane/pid still existing), assembling the liveness facts READ-TIME in `reconcile`/`loadReconcileSnapshot` via the existing `listPanes()` probe in src/exec-backend.ts — never inside a reducer fold (re-fold determinism is sacrosanct; folds never read liveness). Align the new notion with src/readiness.ts `isLiveWorkOccupant` rather than minting a third occupancy definition. Apply at BOTH `isOccupyingJob` call sites in `reconcile` (the task row and the close row — a dead close worker wedges epic closure the same way). Do not touch the `liveTabKeys`/`pending_dispatches` arm or the 200s redispatch cooldown — those guard the launch→SessionStart window and fold lag, and loosening them reintroduces documented double-dispatch races; keep the new gate's ordering relative to the budget/armed gates as the surrounding comments prescribe. Update the existing test that pins stopped-always-occupies and add the stopped-but-dead-pane dispatches case plus a stopped-but-live-pane still-occupies case using the local makeJob helper; poll with retryUntil, never sleeps.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:705-720 — isOccupyingJob, the predicate
- src/autopilot-worker.ts:873-881 and :923 — the two reconcile call sites
- src/autopilot-worker.ts:1365-1368 — loadReconcileSnapshot, where a liveness join belongs
- src/autopilot-worker.ts:77-222 — the double-dispatch race history the fix must not reopen
- src/readiness.ts:903-911 — isLiveWorkOccupant, the occupancy notion to align with
- src/exec-backend.ts:82,538 — listPanes, the existing liveness probe to reuse
- test/autopilot-worker.test.ts:433-501 — the isOccupyingJob test block (the :447 case pins the wedge and must change)

## Acceptance

- [ ] Stopped-with-dead-pane rows no longer occupy; stopped-with-live-pane and working rows still occupy; ended/killed unchanged
- [ ] Both reconcile call sites covered; no changes to cooldown/liveTabKeys arms; no liveness reads in any fold
- [ ] test/autopilot-worker.test.ts updated incl. both new liveness cases; bun test green and bun run test:full green

## Done summary
Gated the stopped arm of isOccupyingJob on read-time pane liveness (listPanes probe threaded through loadReconcileSnapshot), so a stopped-dead worker no longer wedges its task out of dispatch; working and stopped-with-live-pane rows still occupy, a null probe falls back conservatively, and folds never read liveness.
## Evidence
