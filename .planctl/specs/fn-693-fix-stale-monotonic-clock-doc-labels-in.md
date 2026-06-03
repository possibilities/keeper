## Overview

After fn-692 swapped `nowMs` from `performance.now()` to `Date.now()`, several
doc-comments in `src/git-worker.ts` still describe `nowMs`, `cleanSinceByRoot`,
`lastFullSweepMs`, and `WatchProbeCacheEntry.expiry` as "monotonic clock" —
creating a regression trap for future readers of the interface docs who could
reasonably revert to `performance.now()` and reintroduce the clock-domain
mismatch bug the fn-692 test now pins.

## Acceptance

- [ ] All stale "monotonic"/"performance.now()" doc-labels on `nowMs`,
      `cleanSinceByRoot`, `lastFullSweepMs`, and `WatchProbeCacheEntry.expiry`
      updated to reflect `Date.now()` (wall clock).
- [ ] Correctly monotonic labels (HEAD-divergence watchdog at lines 366, 1715,
      1887, 1902) left unchanged.
- [ ] Full `git-worker.test.ts` suite still passes.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Stale "monotonic clock" labels on DiscoveryOptions.nowMs and computeWatchDelta signature — interface readers see wrong clock domain, concrete regression trap |

## Out of scope

- No changes to the HEAD-divergence watchdog (lines 366, 1715, 1887, 1902) — those correctly use performance.now()
- No behavioral changes — doc-comments only
