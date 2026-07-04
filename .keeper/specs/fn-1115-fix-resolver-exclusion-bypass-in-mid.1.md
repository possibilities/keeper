## Description

Fixes F1 (merged: F2's test gap). In
`recoverSharedCheckoutMidMerge` (src/autopilot-worker.ts, ~line 3319-3333) the
owning-epic derivation `for-each-ref --points-at=<mergeHead> refs/heads/keeper/epic/`
currently maps a non-zero exit (124 timeout / spawn failure) to
`owningEpics = []`. Because `[].some(hasActiveResolver)` is false, the guard
is skipped and the pass proceeds to the flock-guarded `git merge --abort`,
which can destroy a live `resolve::<epic>` worker's in-progress resolution.

Mirror the fail-safe discipline used everywhere else in the function (owner
probe at ~line 3295, autostash/for-each-ref inconclusive => foreign/defer):
when `refsAt.code !== 0`, return a defer `WorktreeRecoveryFailure` naming the
inconclusive owning-epic probe (e.g. a `worktree-recover-mid-merge` /
`-lock-timeout`-style reason that states "inconclusive owning-epic probe,
deferring") with `epicId: null, dir: repo`, BEFORE deriving `owningEpics` —
so an unknown resolver state defers to the next level-triggered cycle rather
than aborting. Distinguish a spawn/timeout code from a clean empty result so a
genuinely resolver-free wedge still self-heals.

Add the test that F2 flagged missing: keeper-owned mid-merge + the owning-epic
`for-each-ref` fake returning `{code: 1}` (or the 124 timeout code) => assert
the pass returns a defer reason and issues NO `merge --abort`. The existing
suite already covers the succeeding-probe live-resolver case; this pins the
failing-probe branch.

## Acceptance

- [ ] `refsAt.code !== 0` returns a defer `WorktreeRecoveryFailure` (epicId null, dir repo) that names the inconclusive owning-epic probe, before any abort.
- [ ] A resolver-free keeper-owned wedge with a SUCCEEDING empty probe still self-heals (no regression to the clean abort path).
- [ ] New fast-tier test: keeper-owned mid-merge + failing owning-epic for-each-ref asserts a defer and zero abort invocations.

## Done summary

## Evidence
