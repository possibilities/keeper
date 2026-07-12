## Description

**Size:** S
**Files:** src/worktree-git.ts, test/worktree-git.test.ts

### Approach

Add pure, injected-git primitives to MEASURE base-drift — none exists today
(`git-worker.ts:396 parseBranchAheadBehind` parses only per-status upstream ahead/behind,
NOT base-vs-default). Two reads through the GitRunner/`gitExec` seam (bounded by
`GIT_LOCAL_TIMEOUT_MS`): (a) behind-count via `git rev-list --left-right --count <base>...<default>`
(default commits the base lacks); (b) merge-base age via `git show -s --format=%ct
$(git merge-base <base> <default>)`. Tri-state discipline: a definite magnitude on git
exit 0, a DISTINCT inconclusive on timeout(124)/ambiguous-ref(128)/spawn-fail so callers
DEFER — never treat inconclusive as high drift. Never throw.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required:**
- src/worktree-git.ts:603 — `isAncestorOf` (the runner-seam wrapper pattern to mirror)
- src/worktree-git.ts:1554 — `mergeBranchInto` (GitRunner injection seam)
- src/git-worker.ts:396 — `parseBranchAheadBehind` (the wrong axis — confirms this is net-new)

**Optional:**
- src/autopilot-worker.ts:2895-2917 — inlined tri-state exit-code discipline to copy

### Risks

Ref order in the `--left-right` count decides which side is "behind" — get it wrong and every lane reads drifted. A freshly-cut lane is behind by every post-fork commit (high count) but has a recent merge-base age; both feed the OR trigger in `.2`.

### Test notes

Unit-test with a faked GitRunner: exit-0 magnitudes; inconclusive on 124/128/spawn-fail → a distinct value callers defer on. No real git in the fast tier (a slow variant may drive real git).

## Acceptance

- [ ] A primitive returns the base's behind-count vs the local default AND the merge-base age, through the injected git seam.
- [ ] Timeout / ambiguous-ref / spawn failure returns a DISTINCT inconclusive value (never a false magnitude); the function never throws.

## Done summary
Added measureBaseDrift, a pure injected-git primitive in worktree-git.ts returning behind-count (git rev-list --left-right --count) and merge-base commit timestamp (git show %ct), with a distinct inconclusive kind on timeout/ambiguous-ref/spawn-fail so callers defer rather than misread drift.
## Evidence
