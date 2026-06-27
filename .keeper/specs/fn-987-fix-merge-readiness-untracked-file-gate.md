## Overview

`mergeReadiness` treats any untracked file in the shared main checkout as a
dirty tree, so finalize/recover silently skip-and-retry every cycle whenever
the human's checkout holds a benign untracked file (editor temp, un-ignored
artifact, a `.env`). Because the skip is a no-sticky `retry`, nothing
surfaces — the epic just never finalizes and the lane worktree + base/rib
branches pile up, re-introducing the exact leak this surface was hardened to
prevent. This narrows the clean-tree check to tracked/staged/unmerged state.

## Acceptance

- [ ] An untracked-only shared checkout finalizes instead of skip-and-retrying
- [ ] Staged / modified / unmerged WIP still degrades to a clean skip-and-retry

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | mergeReadiness (worktree-git.ts:457) counts untracked files as dirty, forcing a silent never-finalize skip-and-retry |
| F2 | culled | — | one past fn-id in a single comment (autopilot-worker.ts:2615) is a convention nitpick with no user or behavior impact |
| F3 | culled | — | remotePushFastForwardable origin hard-coding (worktree-git.ts:480) is not a regression and non-origin remotes are out of scope |
| F4 | merged-into-F1 | .1 | F4's untracked-only mergeReadiness test proves F1's fix, so it folds into F1's task |

## Out of scope

- The `origin`-hard-coded remote precheck (F3) — pre-existing assumption, not a regression
- The fn-id provenance comment cleanup (F2) — convention nitpick deferred to next touch
