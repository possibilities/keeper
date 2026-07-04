## Overview

The tabs-restore hardening epic bounded the generation-snapshot decode to the
current generation plus the newest RECENT_GENERATION_BOUND dead ones, but two
seams were left behind: user-facing help/doc strings still promise an
exhaustive generation list, and the security-critical error-path comment
sanitization has no regression test. This follow-up closes both — a doc
accuracy pass and a test-coverage pass on the injection-hardening seam.

## Acceptance

- [ ] `keeper tabs list` help and the `TabsListPayload` doc describe the
  bounded window, not an exhaustive list
- [ ] The `--generation` help notes it cannot reach a generation past the
  decode bound
- [ ] A test exercises `commentSafe(o.error)` on the renderOutcomes FAILED
  branch with a newline-bearing error

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/tabs.ts:94 and src/tabs-core.ts:592-597 promise "every observed generation" but commit 683d9c04 bounds the decode to current + K dead; the help text is now a false exhaustiveness promise. |
| F2 | merged-into-F1 | .1 | F2's --generation help gap (cli/tabs.ts:116 omitting the K cap) shares F1's root cause and file — the tabs help text not reflecting the decode bound — so it folds into F1's doc sweep as one commit. |
| F3 | kept | .2 | renderOutcomes FAILED-branch commentSafe(o.error) is an agent-influenced comment-interpolation site with no newline-bearing test; a dropped call reopens the injection vector and passes CI. |
| F4 | culled | — | Superseded commit 2d43faa leaves no tree artifact (stale file and test both absent); nothing is actionable in code. |

## Out of scope

- Rewording the "may have been reaped" note to distinguish "past the decode
  bound" from "reaped" (marginal; no in-tool path surfaces an out-of-bound id
  since `tabs list` is bounded identically).
- Any change to the decode bound itself or RECENT_GENERATION_BOUND.
