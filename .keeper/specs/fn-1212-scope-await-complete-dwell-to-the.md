## Overview

`keeper await complete fn-N.M` debounces its confirmation on an elapsed
dwell anchored to a target-row version, but for a task target that version is
the CONTAINING epic's `last_event_id` and the dwell restarts on ANY version
move. In a multi-task epic, sibling churn re-folds the epic row faster than
the dwell (siblings emit events < COMPLETE_DWELL_MS = 250ms apart; diffTick
polls at 50ms), so a task-complete await never settles until the WHOLE epic
quiets — a delayed-confirmation regression on precisely the surface fn-1210
exists to un-hang. Resolve the sibling-churn reset and pin the intended
behavior with a test.

## Acceptance

- [ ] A task-complete await in a multi-task epic no longer has its dwell reset
      by benign sibling-task churn, while a genuine target-task flap (including
      a diffTick-coalesced running→completed) still restarts the dwell.
- [ ] The chosen resolution — a per-task version anchor, or a conscious
      accept-and-document of the epic-settle tradeoff — is reflected in the
      `advanceCompleteStability` / `completeWatermark` docs so the next reader
      is not surprised.
- [ ] A test names the sibling-churn scenario and asserts the intended outcome.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Verified in commit 8e43ff96: advanceCompleteStability restarts the dwell on any versionMoved and completeWatermark returns the epic's last_event_id for a task target, so sibling churn resets a task-complete await's dwell until the epic quiets. |
| F2 | culled | — | Stale "pure consecutive count" phrasing in completeWatermark's doc is a low-impact nit; the adjacent advanceCompleteStability doc already states the correct pure-elapsed-dwell model. |
| F3 | merged-into-F1 | .1 | The missing sibling-churn e2e test (F3) shares F1's root cause (epic-scoped watermark reset), so it folds into F1's task — fix and test land together. |

## Out of scope

- The quiet-board hang fix itself (shipped and audited clean in fn-1210).
- The F2 stale-comment reword (culled as a low-impact nit).
- Broader rework of the subscribe/diffTick change-driven stream.
