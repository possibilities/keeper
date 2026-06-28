## Overview

The `## Autopilot` guardrail in CLAUDE.md still groups a non-fast-forward
shared checkout with the dirty/off-branch transient skips, claiming finalize
degrades it into a `retry` skip that mints no sticky row. The shipped code now
makes a genuine origin-ahead non-ff a VISIBLE sticky DispatchFailed instead.
This is a docs-only correction so a future agent reading the guardrail does not
"fix" the intentional sticky back into a retry-skip.

## Acceptance

- [ ] The CLAUDE.md worktree-mode guardrail describes the shipped non-ff sticky behavior
- [ ] dirty/off-branch (and the lock/local timeouts) are still described as non-sticky retry skips

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | CLAUDE.md:116 groups non-ff as a retry-skip but src/autopilot-worker.ts:2634-2646 now mints a visible sticky — the guardrail doc lies and invites reverting the behavior. |
| F2 | culled | —  | The requested non-ff call-site note already exists at src/autopilot-worker.ts:2635-2642. |
| F3 | culled | —  | Theoretical acquireWithDeadline backoff-clamp coverage gap; arithmetic verified correct on an already 1.9:1 covered path. |
| F4 | culled | —  | mergeBranchInto is-ancestor 124 fall-through is verify-only and justified by the existing comment. |

## Out of scope

- Any code change to the non-ff arm — the shipped behavior is correct; only the doc lags.
- Added tests for the acquireWithDeadline backoff clamp or the is-ancestor 124 fall-through (F3/F4 culled).
