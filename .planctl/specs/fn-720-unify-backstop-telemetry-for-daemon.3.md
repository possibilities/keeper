## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/daemon.ts, test/autopilot-worker.test.ts, test/daemon.test.ts

Wire the two `timeout` class backstops: the autopilot `confirmRunning`
ceiling and the pending-dispatch TTL sweep. These measure
elapsed-since-dispatch (NOT staleness-since-fast-path), have no missed fast
path (`fast_path:null`, `last_fast_path_at:null`), and already emit
`DispatchFailed`/`DispatchExpired` — this adds the uniform telemetry record
ALONGSIDE those existing events without changing dispatch behavior.

### Approach

autopilot `confirmRunning` (src/autopilot-worker.ts:818-850): when the
ceiling is hit (SessionStart never arrived → DispatchFailed) post a
`{class:"timeout", backstop:"autopilot-ceiling", rescued:true,
staleness_ms:elapsedMs}` record; when a dispatch confirms BEFORE the
ceiling, bump the counter as `rescued:false` (the denominator). Use the
injected `deps.now` clock (no wall-clock surprises). pending-dispatch sweep
(src/daemon.ts:2411, timer :2448): when a row expires → DispatchExpired,
post `{class:"timeout", backstop:"pending-dispatch-sweep", rescued:true}`;
a sweep pass that expires nothing bumps `rescued:false`. main is already
the writer here (no postMessage needed for the daemon-side sweep).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:818-850 — confirmRunning poll/ceiling; DEFAULT_POLL_INTERVAL_MS:524, DEFAULT_CEILING_MS:539; pure-with-injected-deps (deps.now/sleep/findJob).
- src/daemon.ts:2411 (sweepExpiredPendingDispatches), :2448 (timer), :268 (PENDING_DISPATCH_SWEEP_INTERVAL_MS), :287 (selectExpired selector).
- src/backstop-telemetry.ts (from `.1`) — record/counter API.
- test/autopilot-worker.test.ts — fake-clock harness for ceiling branches.

### Risks

- Category correctness: do NOT reuse the missed-wake staleness semantics — `last_fast_path_at` is null and `staleness_ms` is elapsed-since-dispatch. The `class` discriminator must keep these distinct so the aggregation script never mixes them.
- Must not perturb the existing DispatchFailed/DispatchExpired emit or the dispatch gates — telemetry is strictly additive.

### Test notes

Fake-clock test: ceiling-hit posts a timeout rescue with elapsedMs
staleness; a pre-ceiling confirm bumps rescued:false. Sweep test: an
expired row posts a rescue; an empty sweep bumps the denominator. Assert
DispatchFailed/DispatchExpired behavior unchanged.

## Acceptance

- [ ] autopilot ceiling posts a `timeout` rescue (elapsedMs staleness, fast_path/last_fast_path_at null) on ceiling-hit; pre-ceiling confirm counted as rescued:false.
- [ ] pending-dispatch sweep posts a `timeout` rescue on expiry; empty sweep counted as rescued:false.
- [ ] DispatchFailed/DispatchExpired emits and all dispatch gates unchanged (verified by existing tests).
- [ ] `class:"timeout"` records carry null fast_path/last_fast_path_at; `bun test` green.

## Done summary

## Evidence
