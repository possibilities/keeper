## Overview

The wedged-slot paging backstop deleted `MONITOR_RELEASE_SEC` and added a new
dead-pid occupant loop, leaving two comments describing the pre-change world:
a doc-comment that cites the now-deleted symbol, and a producer-loop invariant
that the new code falsifies. This follow-up is a comment-accuracy sweep only —
no behavior changes.

## Acceptance

- [ ] No comment in `src/` references the deleted `MONITOR_RELEASE_SEC` symbol
- [ ] The `provenDeadJobIds` comment accurately describes the set's contents under a degraded pane probe

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | Impure glue over tested pure seams; no defect shown, self-corrects next probe cycle, auditor-rated low urgency |
| F2 | kept | .1 | collections.ts:325 doc-comment references deleted MONITOR_RELEASE_SEC (only surviving ref in src/); grep-surprise + rule #0 |
| F3 | merged-into-F2 | .1 | F3 (provenDeadJobIds comment overstates the livePaneIds===null empty-set guarantee) folds into F2's comment sweep — same commit-churn comment debt |
| F4 | culled | — | Test uses SHARED_DESYNC_DISTRESS_VERB (== "daemon"); test is correct, pure naming nit |

## Out of scope

- Any direct test for the loadReconcileSnapshot/main integration glue (F1, culled — pure seams cover the decision logic)
- Renaming the SHARED_DESYNC_DISTRESS_VERB constant in daemon.test.ts (F4, culled)
- Any behavior, gating, or code-logic change to the paging backstop
