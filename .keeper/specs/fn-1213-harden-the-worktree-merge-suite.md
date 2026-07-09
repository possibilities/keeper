## Overview

The worktree finalize merge-suite gate shipped with two loose ends surviving
audit: the production suite probe's verdict-classifier mapping has no direct
test coverage (only the injected fake is exercised), and that probe runs a
multi-minute suite INLINE on the single-flight reconcile drive, freezing all
board-wide autopilot progress on every successful worktree-mode close. This
follow-up closes the coverage gap and isolates the run off the reconcile drive.

## Acceptance

- [ ] Every verdict branch of the production merge-suite probe is unit-tested at its injectable seams
- [ ] The suite run no longer blocks the single-flight reconcile loop board-wide (or the inline block is documented as an accepted opt-in tradeoff)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Production probe (runMergeSuiteGate/runPackageSuiteGate/readPkgGateCommand) verdict-mapping has zero test references; only injected-fake finalize tests exist. |
| F2 | culled | — | Ran KEEPER_PLAN_RUN_SLOW=1 on the lane: rewritten slow-tier tests pass 8/8; {ok:true} rewrites correctly replace stale assertions. |
| F3 | culled | — | (fn-1204) provenance comments are a style nitpick; de-facto convention across 61 src files, no user impact. |
| F4 | culled | — | classifyRun crashed->red is an explicitly-documented, defensible tradeoff (visible park over silent forever-retry). |
| F5 | merged-into-F1 | .1 | F5 (Test Gaps) is the same untested-production-probe root cause as F1; folded into F1's coverage task. |
| F6 | culled | — | Same as F2 (Test Gaps restatement); both slow-tier tests verified green on the lane. |
| F7 | kept | .2 | runMergeSuiteGate runs inline on the single-flight reconcile drive (~25-50min), freezing board-wide autopilot on every green close; fatalExit sub-fear refuted. |
| F8 | culled | — | Merged-commit-keyed memo latching a flaky red is sound for deterministic suites and self-heals on daemon restart. |

## Out of scope

- The classifyRun crashed->red mapping (F4) and the memo flaky-red latch (F8) — both accepted, documented tradeoffs.
- (fn-1204) provenance comment cleanup (F3) — de-facto convention, not worth an isolated churn.
