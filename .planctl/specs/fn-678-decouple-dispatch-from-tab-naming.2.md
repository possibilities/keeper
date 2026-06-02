## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

Build the event-sourced core. Add `DispatchedPayload {verb, id, dir, ts}`
and `DispatchExpiredPayload {verb, id}` with `extractDispatchedPayload` /
`extractDispatchExpiredPayload` (strict null-on-miss, mirroring
`extractDispatchFailedPayload`). `foldDispatched` UPSERTs into
`pending_dispatches` (row presence is the only signal — no status
column). `foldDispatchExpired` is an idempotent DELETE that must NOT throw
on a missing row (a boot-drain race where SessionStart already discharged
it). Widen `foldDispatchFailed` to ALSO DELETE the matching
`pending_dispatches` row in the SAME fold transaction (outbox: `Dispatched`
mints before launch, so a launch failure leaves both rows until this
arm reconciles them). Add discharge-on-bind: in the SessionStart
spawn-INSERT path, when `plan_verb`/`plan_ref` are stamped set-once on the
INSERT branch (NOT the resume ON CONFLICT branch — a resume must not
discharge a legitimately re-pending dispatch), `DELETE FROM
pending_dispatches WHERE verb = plan_verb AND id = plan_ref`. Register both
new events in the `applyEvent` hook_event dispatch table. Folds read only
`event.ts`; never wallclock/env/fs.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:3045 — `DispatchFailedPayload` / `extractDispatchFailedPayload` / `foldDispatchFailed` / `foldDispatchCleared` (line-for-line precedent)
- src/reducer.ts:5795 — SessionStart `INSERT INTO jobs ... ON CONFLICT DO UPDATE`; `planVerbRefFromSpawnName` set-once seam (BIND discharge site, spawn-INSERT branch only)
- src/reducer.ts:6698 — `applyEvent` hook_event dispatch table

**Optional** (reference as needed):
- src/db.ts:1100 — `dispatch_failures` UPSERT/DELETE SQL shape

### Risks

- Discharge DELETE on the resume ON CONFLICT branch would clear a legitimately re-pending `(verb, id)` — must be spawn-INSERT only.
- A fold throwing on a missing row wedges the reducer (cursor rolls back) — `foldDispatchExpired` must be a safe no-op on absent rows.
- Re-fold determinism: any wallclock read inside a fold is forbidden.

### Test notes

Fold tests for UPSERT / idempotent-DELETE / widened-FAIL-also-deletes-pending /
discharge-on-bind-spawn-only. Re-fold determinism: a cursor=0 re-fold over a
log carrying `Dispatched` + later `SessionStart` reproduces a byte-identical
(empty, discharged) `pending_dispatches`; a historical log with no `Dispatched`
events reproduces an empty table.

## Acceptance

- [ ] `foldDispatched` (UPSERT) and `foldDispatchExpired` (idempotent DELETE, no-throw on missing) implemented + registered in `applyEvent`
- [ ] `foldDispatchFailed` deletes the matching `pending_dispatches` row in the same fold tx
- [ ] Discharge-on-bind fires only on the SessionStart spawn-INSERT branch
- [ ] Malformed `Dispatched`/`DispatchExpired` payload folds to a no-op and the cursor advances
- [ ] Re-fold determinism test passes (empty over historical log; discharged over Dispatched+SessionStart)

## Done summary

## Evidence
