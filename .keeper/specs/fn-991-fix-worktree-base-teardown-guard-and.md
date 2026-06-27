## Overview

The worktree-mode finalize/merge-routing epic shipped a correct projection-done
gate and a consolidated merge routine, but the audit surfaced one correctness
gap and one stale-doc drift. Recover pass-3 tears down an epic BASE solely on
is-ancestor-of-default, which silently sweeps an ACTIVE forked epic whose base
still sits at the default tip (a reflexive ancestor before its first fan-in).
Separately, the README still documents the removed lane-spec finalize gate as
current. This follow-up closes both.

## Acceptance

- [ ] An OPEN forked epic whose base is an ancestor of default (no commits yet) is PRESERVED by recover pass-3
- [ ] A reaped/done epic's merged orphan base is still torn down (no regression)
- [ ] The README worktree section describes the projection-done (isEpicDone) finalize gate, with no reference to the removed epicBaseHasDoneState mechanism

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | autopilot-worker.ts:3087 gates base teardown only on gitIsAncestorOf while a base is born at default tip (worktree-git.ts:736), so an active forked epic's base is swept mid-flight |
| F2 | kept | .2 | README.md:3198 still describes the removed epicBaseHasDoneState lane-spec gate as current; finalize now gates on isEpicDone (autopilot-worker.ts:2565) |
| F3 | culled | — | transient post-merge push-timeout window self-heals on the next default push (merge commit local, not lost); no data loss, opt-in path |
| F4 | culled | — | done-guard-miss console.error is log-noise on an abnormal crashed-closer state; no user-facing impact |
| F5 | merged-into-F1 | .1 | F5 is the open-base-preserved test the auditor recommends for F1's pass-3 guard fix; folds into F1's task |
| F6 | culled | — | F6 tests the merge-then-push-timeout resume for F3, which is culled; no surviving fix to cover |

## Out of scope

- F3 not-ahead post-push-timeout idempotency (self-healing transient window, deferred)
- F4 done-guard-miss log-noise rate-limiting (observability nicety)
