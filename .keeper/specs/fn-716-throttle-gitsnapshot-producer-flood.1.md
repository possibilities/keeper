## Description

**Size:** S
**Files:** src/rescan.ts, test/rescan.test.ts

### Approach

Extend `RescanScheduler` with an optional max-wait / latency-ceiling so a
continuously-bursting source still flushes within a bounded window instead
of deferring forever under a pure trailing-edge debounce. Add the cap as an
OPTIONAL constructor param defaulting to "no ceiling" so the existing
trailing-only callers (transcript-worker, plan-worker drop-recovery) keep
byte-identical behavior. When a max-wait is set, the first `schedule()`
after an idle period arms a ceiling timer; a flush (trailing or ceiling)
clears it. Keep the single-flight + pending dirty-bit semantics intact.

### Investigation targets

**Required** (read before coding):
- src/rescan.ts:103 — RescanScheduler: debounce timer, inFlight, pending dirty-bit, injectable SchedulerTimers, cancel()
- test/rescan.test.ts — fake-clock harness (pendingCount/flush); model new ceiling tests on it

**Optional**:
- src/git-worker.ts:2186 — the schedulerFor(root) caller that will pass the ceiling in task .2 (don't edit here)
- src/transcript-worker.ts, src/plan-worker.ts — the other RescanScheduler callers whose trailing-only contract must NOT regress

### Risks

Changing a primitive shared by three workers — the default must preserve
existing trailing-only behavior exactly. Cover "ceiling unset = old
behavior" explicitly.

### Test notes

Use the existing fake-clock SchedulerTimers harness: assert (a) ceiling
unset → unchanged trailing behavior; (b) ceiling set + continuous schedule()
faster than debounce → flush fires at the ceiling; (c) single-flight +
mid-scan dirty-bit re-run still hold with a ceiling.

## Acceptance

- [ ] RescanScheduler accepts an optional max-wait ceiling; default = no ceiling = current trailing-only behavior (existing tests unchanged)
- [ ] With a ceiling set, continuous `schedule()` calls faster than the debounce window still flush within the ceiling (fake-clock test)
- [ ] single-flight + pending dirty-bit semantics preserved under the ceiling
- [ ] `cancel()` clears both the debounce and ceiling timers

## Done summary
Added an optional max-wait ceiling to RescanScheduler: default 0 preserves byte-identical trailing-only behavior; a set ceiling bounds staleness under continuous churn by flushing at maxWaitMs; cancel() clears both timers. Fake-clock harness gained flushDelay(ms).
## Evidence
