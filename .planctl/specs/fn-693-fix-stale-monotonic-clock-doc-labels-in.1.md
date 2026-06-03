## Description

(F1) Fix stale "monotonic clock" doc-labels left by fn-692's clock-source swap
in `src/git-worker.ts`. Affected sites (all `nowMs`/wall-clock users):

- Line 1176: WatchProbeCacheEntry — "expiry is monotonic (`performance.now()` ms)"
- Line 1186: "Monotonic-clock ms after which the entry is considered stale."
- Line 1205: DiscoveryOptions — "`nowMs` — monotonic clock. Injected for tests."
- Lines 1301/1305: computeWatchDelta params — "monotonic clock" for cleanSinceByRoot and nowMs
- Lines 1697/1707: cleanSinceByRoot and lastFullSweepMs local-var comments — "monotonic"

Lines 366 (HEAD_DIVERGENCE_GRACE_MS), 1715 (headDivergentSinceByRoot), 1887/1902
(snapshotSuppressedByDivergence) correctly reference `performance.now()` — leave untouched.

Evidence: git-worker.ts:2054 `const nowMs = Date.now()` (fn-692 fix site);
git-worker.ts:1887 `performance.now()` (HEAD-divergence — still correct and untouched).

## Acceptance

- [ ] All stale "monotonic"/"performance.now()" labels at the listed sites replaced
      with "wall clock (Date.now())" language
- [ ] Lines 366, 1715, 1887, 1902 (performance.now() users) left unchanged
- [ ] `bun test test/git-worker.test.ts` passes

## Done summary

## Evidence
