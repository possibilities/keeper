## Description

**Size:** M
**Files:** src/exit-watcher.ts, src/wake-worker.ts, src/tmux-control-worker.ts, cli/await.ts, src/autopilot-worker.ts, test/exit-watcher.test.ts, test/wake-worker.test.ts, test/tmux-control-worker.test.ts, test/await.test.ts, test/autopilot-worker.test.ts, test/helpers/retry-until.ts

### Approach

Expose one-step loop/state-machine and injected scheduler seams for watcher diffs, idle wakes, tmux rereads, await reconnect, timeout/grace, and autopilot cadence. Replace fixed sleeps, negative settle windows, and production-duration timeout tests with explicit deferred operations, fake clocks, pending-work inspection, and deterministic microtask draining. Retain `retryUntil` only for positive completion across a genuine async boundary; it is never a substitute for a negative sleep.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/wake-worker.test.ts:66-217 — fixed cadence, idle, and coalescing waits
- test/exit-watcher.test.ts:86-121,190-211,1141-1175 — diff and no-duplicate settle waits
- test/tmux-control-worker.test.ts:559-687 — handshake/redirty waits
- test/await.test.ts:2238-2242,2499-2500 — injected clock combined with real reconnect waits
- src/rescan.ts:64-76,115-163 — established injectable timer seam
- test/readiness-client.test.ts:1388-1432 — fake clock/timer capture precedent

**Optional** (reference as needed):
- Bun fake-time documentation — reset requirements and limitations

### Risks

Fake time can diverge from promise/abort/microtask ordering. Tests must assert exact deadline boundaries, cancellation, and queued-work state rather than only final values. Production loops remain bounded and supervisor-owned.

### Test notes

Cover deadline−1/deadline/deadline+1, wake coalescing, redirty once, shutdown, reconnect, cancellation, and no-duplicate outcomes synchronously. Reset fake clocks in `finally`/`afterEach`.

### Detailed phases

1. Extract pure step/transition functions from each loop.
2. Inject scheduler/sleep/deadline dependencies into thin drivers.
3. Rewrite positive paths with controlled deferreds.
4. Rewrite negative assertions around explicit idle/pending state.
5. Remove every fixed sleep and real-clock performance assertion from the listed fast suites.

### Alternatives

Polling with shorter sleeps was rejected because it remains nondeterministic and contention-sensitive.

### Non-functional targets

Scheduling tests add no intentional elapsed delay; production intervals and grace constants remain unchanged.

### Rollout

Keep production loop signatures backward-compatible through default dependencies, then remove defaults only where callers already inject supervision.

## Acceptance

- [ ] Listed fast tests contain no fixed real-time sleep or elapsed-time assertion.
- [ ] Watcher, wake, tmux reread, await reconnect, timeout, and autopilot cadence contracts are proved through deterministic steps and fake scheduling.
- [ ] Negative no-extra-work assertions inspect explicit pending/idle state rather than waiting.
- [ ] `retryUntil` remains only on genuine positive async boundaries and no fixed wait is added as fallback.
- [ ] Production timing, cancellation, and shutdown behavior remains observable through thin injected drivers.

## Done summary

## Evidence
