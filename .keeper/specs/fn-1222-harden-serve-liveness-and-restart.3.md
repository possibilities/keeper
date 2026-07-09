## Description

**Size:** M
**Files:** scripts/repro-serve-wedge.ts, src/server-worker.ts, test/daemon.test.ts

### Approach

Two phases, characterize before fixing. Phase 1: extend the repro harness with subscribe-churn
and register-stampede load shapes and answer the open mechanism question — does a client
hitting its 10s first-paint give-up close its socket (slow close handling) or abandon it live
(a conn the existing dead-peer/unengaged/idle reapers all miss: live pid, everEngaged,
subscribed)? Phase 2, per findings: add the missing reap predicate for abandoned-but-alive
subscribed conns, and bound diffTick fan-out per tick (subscribed_conns × watched_ids ×
collections grows unbounded with board size — the re-fold time-bomb discipline transplanted to
the serve loop) with an explicit anti-starvation service order so deferred subscriptions are
always serviced within a bounded number of ticks. The characterization result is a recorded
deliverable in the Done summary either way.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/server-worker.ts:2388-2580 — the reaper family + census: reapStuckPending / reapIdleConns / reapDeadPeers / reapUnengaged (≈2479), sub_live/sub_dead/sub_unknown buckets
- src/server-worker.ts:2618 — diffTick: the per-fold fan-out whose cost this task bounds
- scripts/repro-serve-wedge.ts — the harness's existing --clients/--rate-hz/register-work knobs the new load shapes join

**Optional** (reference as needed):
- cli/board.ts and cli/status.ts — the client give-up path whose socket behavior phase 1 characterizes

### Risks

- A fan-out bound that defers the wrong subscriptions starves real board viewers — the service order must be round-robin or aged, never priority-by-recency alone
- Reaping a conn the client still holds open half-kills a live viewer; the predicate needs positive abandonment evidence (give-up observed or engagement ceased past a bound)

### Test notes

diffTick fan-out bounding is unit-testable with a fake conn set (pure seam); the reap predicate
gets census-level tests; the end-to-end starvation → recovery arc runs in the repro harness
(slow tier / manual), not bun test.

## Acceptance

- [ ] The repro harness reproduces the subscribe-churn wedge shape and the ghost-subscription mechanism is characterized with the answer recorded
- [ ] Abandoned-but-alive subscribed connections are reaped within a bounded interval under the new predicate
- [ ] Per-tick diffTick fan-out is bounded and every deferred subscription is serviced within a bounded number of ticks, proven by a pure fake-conn-set test
- [ ] Fast suite passes; the harness arc is documented in the task evidence

## Done summary

## Evidence
