## Description

**Size:** M
**Files:** src/git-worker.ts, test/git-worker.test.ts

### Approach

Gated on .1's FSEvents-coverage proof. Remove the snapshot fan-out from the
data_version path: `decideDataVersionWake` (src/git-worker.ts:2036) collapses
to a membership-only decision (drop the `schedule`/`nextScheduleAtMs` arm and
the `DATA_VERSION_SCHEDULE_FLOOR_MS` self-write floor it gated); the poll loop
(2784-2804) keeps `reconcileRoots()` on every advance and deletes the
`for (const root of subscriptions.keys()) schedulerFor(root).schedule()`
fan-out (2800-2802). Keep `lastDataVersion` (membership advance-detection
still needs it); remove the now-dead `lastDataVersionScheduleAtMs` +
`DATA_VERSION_SCHEDULE_FLOOR_MS`. Per-root snapshots now come solely from the
worktree + git-dir FSEvents subs + the 60s heartbeat. Update the five pinned
`toEqual` tests (test/git-worker.test.ts:2932-2981) and the JSDoc
(2001-2029) in lockstep with the new return shape. Producer-side, read-only
DB — no new DB write / synthetic event / RPC; the kick contract and
membership-reconcile-on-advance behavior are preserved (fn-744's contract).

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2036-2057 — `decideDataVersionWake` (the edit site)
- src/git-worker.ts:2784-2804 — poll loop; delete the fan-out branch, keep reconcile
- src/git-worker.ts:351-383 — constants (`DATA_VERSION_SCHEDULE_FLOOR_MS` now dead; `DB_POLL_MS`/`HEARTBEAT_MS` unchanged)
- test/git-worker.test.ts:2932-2981 — five `toEqual` decision tests to rewrite in lockstep (FLOOR=1000 at :2930)
- src/git-worker.ts:2001-2029 — JSDoc to rewrite to current state (two-legged Membership/Scheduling list collapses to membership-only)

**Optional** (reference as needed):
- .planctl/epics/fn-716-throttle-gitsnapshot-producer-flood.json — what fn-716 committed to (acceptance bar #4 must survive: a real foreign change is still observed, now via FSEvents)
- src/git-worker.ts:2207-2209, 2396-2420 — `markFastPath`/`schedulerFor` (confirm FSEvents arm still stamps `lastFastPathAt`)

### Risks

- Return-shape change breaks the five pinned tests — they must be rewritten,
  not deleted; the membership-only assertion still pins advance-detection.
- Must NOT remove `lastDataVersion` (membership advance-detection needs it).
- `markFastPath`/`lastFastPathAt` is now stamped only by the FSEvents arm —
  confirm the heartbeat staleness denominator stays meaningful (metric
  hygiene; .3 covers the staleness gate if needed).

### Test notes

Unit-level: the rewritten `decideDataVersionWake` tests assert reconcile-on-
advance with no schedule arm. The integration regression (foreign write to A
does not fan to B/C/D) lands in .3 against the live/sandboxed daemon.

## Acceptance

- [ ] `decideDataVersionWake` drives membership reconcile only; the data_version snapshot fan-out (2800-2802) is removed; dead floor constant + schedule-stamp state removed; `lastDataVersion` retained.
- [ ] The five `decideDataVersionWake` tests + the JSDoc are rewritten in lockstep to the membership-only shape; `bun test test/git-worker.test.ts` green.
- [ ] No new DB write / synthetic event / RPC; kick contract + membership-reconcile-on-advance preserved (producer-side, read-only DB).

## Done summary

## Evidence
