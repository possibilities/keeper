## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

`pushDefaultToOrigin` (src/autopilot-worker.ts:2805) runs a BARE `run(["push"])`
at :2824 (no refspec). Under `push.default=simple`, that pushes the CURRENT
HEAD's branch to its upstream, NOT `defaultBranch`. The two re-push callers —
the not-ahead short-circuit in `mergeLaneBaseIntoDefault` (:2889, which runs
BEFORE any readiness/off-branch check) and recover pass-3 (:3226) — then tear
the base down on a `{kind:"pushed"}` that may have pushed the wrong ref, so
`origin/<default>` never advances and the merge is stranded. Compounding it,
`remotePushTurnKey` (src/commit-work/push.ts:172) probes `@{push}` of the
CURRENT HEAD while the FF precheck (src/worktree-git.ts:566) is branch-explicit
on `<default>` — three refs, two HEAD-relative; they agree only when
HEAD==default.

THE FIX (do both):
1. **HEAD-safety.** At the top of `pushDefaultToOrigin`, assert
`gitCurrentBranch(repo) === defaultBranch` (the `currentBranch as gitCurrentBranch`
helper is already imported at :101; an `assertOnDefaultBranch` concept is
referenced at :2479 — reuse it if present). If off-default, return a NEW
`off-branch` arm (degrade, NO push) — this keeps turn-key + FF + push all
consistent (all see HEAD==default). `MergeLaneResult` / `PushDefaultResult`
already carry an `off-branch` arm (:2756/:2768), so the structural-passthrough
contract holds. Map the new arm at BOTH callers: the not-ahead short-circuit
(:2889-2890) → finalize → the existing `worktree-finalize-off-branch`; pass-3
(:3226 via `pushDefaultRecoverReason` :3279) → a new
`worktree-recover-<kind>-off-branch` defer (INSIDE the auto-clear prefix).
Additionally make the push itself branch-explicit (`["push","origin",defaultBranch]`)
as belt-and-suspenders.
2. **Post-push containment recheck.** After `pushDefaultToOrigin` returns
`pushed`, re-run `gitIsAncestorOf(repo, lane.branch, refs/remotes/origin/<default>, run)`
(the cached-ref pattern at src/worktree-git.ts:566-579, NO fetch) before
teardown at BOTH seams (:2889-2890 and :3226-3240). If origin still does not
contain the merge → do NOT tear down; degrade transiently (finalize →
`worktree-finalize-*`, recover → `worktree-recover-*`). Cheap insurance against
"push exited 0 but origin didn't move."

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2805-2839 — pushDefaultToOrigin (bare push :2824, the PushDefaultResult arms)
- src/autopilot-worker.ts:2879-2890 — the not-ahead short-circuit re-push seam (+ its teardown)
- src/autopilot-worker.ts:3218-3240 — pass-3 re-push seam, :3279-3295 pushDefaultRecoverReason (add the off-branch arm)
- src/autopilot-worker.ts:2756 / :2768 — the MergeLaneResult / PushDefaultResult off-branch arm; :2604-2638 finalize reason mapping; :2479 the assertOnDefaultBranch reference; :101 the gitCurrentBranch import
- src/worktree-git.ts:566-579 (origin/<default> cached-ref resolution + gitIsAncestorOf), src/commit-work/push.ts:156-197 (remotePushTurnKey reads @{push} of HEAD)

### Risks

- All three refs (turn-key @{push}, FF branch-explicit, the push) must be made consistent — the on-default assertion aligns them; do not fix only the push.
- The new off-branch arm's reason scoping: finalize-side stays OUTSIDE worktree-recover*, recover-side keeps it (don't let the auto-clear swallow a finalize block).
- The post-push recheck must use the cached origin ref (NO fetch — shared-checkout invariant).

### Test notes

Pure fake-runner (makeRecoveryGit): drive the not-ahead short-circuit AND pass-3
with `repoHead != defaultBranch` → assert NO teardown, NO push to a non-default
ref, and a finalize-off-branch (finalize) / recover-prefixed (pass-3) defer.
Post-push recheck: simulate push→`pushed` but origin still lacks the merge →
assert NO teardown. The existing re-push tests set `repoHead:"main"`; add the
off-default cases.

## Acceptance

- [ ] pushDefaultToOrigin asserts HEAD==default and returns an off-branch arm (no push) when off-default; the push is also branch-explicit
- [ ] the off-branch arm is mapped at both seams (finalize→worktree-finalize-off-branch, pass-3→worktree-recover-*-off-branch defer)
- [ ] a post-push origin-containment recheck gates teardown at both seams — no teardown unless origin/<default> contains the merge
- [ ] tests drive the not-ahead short-circuit AND pass-3 with HEAD != default → no teardown, no wrong-ref push, correct-prefix defer
- [ ] no finalize-side reason satisfies isWorktreeRecoverReason

## Done summary
pushDefaultToOrigin now asserts HEAD==default (off-branch arm, no push) and pushes branch-explicit; a post-push origin-containment recheck gates teardown at both the finalize not-ahead short-circuit and recover pass-3 via a push-unconfirmed degrade, so a lane is torn down only once origin/<default> provably contains the merge.
## Evidence
