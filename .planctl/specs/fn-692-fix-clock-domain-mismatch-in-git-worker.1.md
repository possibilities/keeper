## Description

Finding F2 (fn-690 audit): `reconcileRoots` at `src/git-worker.ts:2046` passes
`performance.now()` as `nowMs` to `discoverProjectRoots`/`buildDiscoveryCandidates`.
The SQL cutoff at line 1274 — `cutoffSec = (options.nowMs - RECENT_JOB_WINDOW_MS) / 1000`
— is then compared against `jobs.updated_at` which is REAL unix seconds. With a
process that's been running 10 minutes, `cutoffSec ≈ (600_000 − 7_200_000) / 1000 = −6,600` —
a negative unix timestamp, so every job ever satisfies `updated_at >= cutoffSec`.
The optimization is silently a no-op; all historical cwds are probed on every fast-path cycle.

Fix: replace `performance.now()` with `Date.now()` at the `nowMs` assignment in `reconcileRoots`.
Note: `decideReconcileTransitions` also receives `nowMs` for the dwell timer — both the stamp
(`cleanSinceByRoot.set(root, nowMs)`) and the check (`nowMs - since >= dwellMs`) use the same
source, so switching to `Date.now()` there is correct (elapsed-time comparisons still hold).
Similarly, `lastFullSweepMs` comparisons use `nowMs` consistently, so the throttle is unaffected.

Add a test that feeds a `performance.now()`-scale `nowMs` (e.g. 60_000ms = 1 minute since
process start) against a DB row with a real `updated_at` (unix seconds, older than the window)
and confirms the row is NOT returned by the fast path — pinning the clock-units contract.

## Acceptance

- [ ] `const nowMs = Date.now()` at `src/git-worker.ts:2046` (one-character-set change)
- [ ] New test: `buildDiscoveryCandidates` with `performance.now()`-scale `nowMs` correctly excludes jobs outside the recent window
- [ ] All existing git-worker tests pass (no changes to injected `nowMs` in existing tests needed)

## Done summary
Replaced performance.now() with Date.now() at reconcileRoots' nowMs site so the SQL cutoff (compared against jobs.updated_at unix-seconds) actually filters; added a buildDiscoveryCandidates test pinning the clock-units contract.
## Evidence
