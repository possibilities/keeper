## Description

**Size:** M
**Files:** src/bus-worker.ts, test/bus-worker.test.ts, test/pi-bus-inbox.test.ts

### Approach

Two bounded pieces, both on the bus-worker pure seams. FIRST, per ADR
0076's presence decision: the channel prune decision gains an age-out
arm — a row with NO live socket whose heartbeat is older than a new
generous horizon constant prunes even when its start-time identity is
unverifiable (the current unconditional keep on a null start-time read
is what lets unverifiable-forever rows accumulate); the fail-safe keep
applies only inside the horizon; a row with a live socket is never
reaped regardless of age. The decision function stays pure (injected
clock and liveness — no wall-clock reads inside it); the driver's
probe bounds, post-await re-check, and fail-open retention steps are
unchanged. Size the horizon to comfortably exceed any legitimate
heartbeat gap including suspend/resume (day-scale, not minute-scale).
SECOND, verification-only arming coverage pinning what is already
correct on main: the duplicate-registration decision's three arms
(live predecessor rejected, dead predecessor evicted-and-taken-over,
send-only admitted without joining the registry) and the Pi
process-global inbox lease's idempotency (double-claim returns the
existing ownership; release then re-claim succeeds; the controller's
idempotent start). No arming production change: the reject chain
terminates the duplicate arm and the watch reconnect backoff stays.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:607-630 — channelPruneDecision; the :617 null-start-time unconditional keep is the arm this task narrows
- src/bus-worker.ts:1687-1735 — pruneStaleChannels driver (probe bounds, post-await live re-check); :121-156 constants (add the horizon beside them)
- src/bus-worker.ts:529 — duplicateRegistrationDecision (the three arms to pin); :500 takeoverVictim identity match
- test/bus-worker.test.ts:278-300, :400-443 — the existing pure-fn test idioms for both decision functions
- plugins/keeper/pi-extension/bus-inbox.ts:63-74, :124-160 — the lease + controller idempotent start to pin
- test/pi-bus-inbox.test.ts — the FakeChild/immediateTimer harness to extend
- docs/adr/0076-bus-retention-past-immune-rows-and-socketless-presence-reap.md and docs/adr/0061-bus-takeover-only-over-dead-predecessor.md — the contracts

**Optional** (reference as needed):
- cli/bus.ts:1094-1132, :1220 — the WatchTerminalError exit-1 chain (read-only reference for what the coverage pins server-side)
- src/bus-db.ts:261, :271 — loadOldestChannels / deleteChannel (existing helpers; no bus-db change expected in this task)

### Risks

- Reaping a live-socket row would evict a healthy watcher — the socket check must gate the age-out arm unconditionally
- A horizon shorter than a real suspend/resume heartbeat gap reaps a sleeping-but-returning subscriber; day-scale generosity is the guard
- The decision function must stay pure — the horizon comparison uses the injected now, never wall-clock inside the fn

### Test notes

Presence: injected-liveness cases for the new age-out arm (socketless +
past-horizon + null start-time → prune; socketless + inside-horizon +
null start-time → keep; live socket + past-horizon → keep). Arming:
the three decision arms plus lease double-claim/release/re-claim and
idempotent controller start, all in-process through the existing fakes.

## Acceptance

- [ ] A socketless channel row past the age horizon is pruned even when its start-time identity is unverifiable; inside the horizon the fail-safe keep holds; a live-socket row survives at any age
- [ ] The channel prune decision remains a pure function of its injected inputs, and the driver's probe bounds and fail-open discipline are unchanged
- [ ] Pure-seam tests pin the duplicate-registration decision's reject/evict/send-only arms and the Pi inbox lease's idempotency (double-claim, release-then-reclaim, idempotent controller start)
- [ ] No production change lands on the arming path
- [ ] The full fast correctness gates stay green

## Done summary
Added a day-scale age-out arm to channelPruneDecision so a socketless row with an unverifiable identity probe prunes past CHANNEL_PRESENCE_HORIZON_MS instead of accumulating forever, keeping the fail-safe keep inside the horizon and never reaping a live-socket row; pinned the pre-existing duplicate-registration reject/evict/send-only arms and the Pi inbox lease's double-claim/release-reclaim idempotency with no arming production change.
## Evidence
