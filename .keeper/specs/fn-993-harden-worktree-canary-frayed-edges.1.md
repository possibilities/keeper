## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

EDGE-1 (merged-arm asymmetry). The shared `mergeLaneBaseIntoDefault`
(src/autopilot-worker.ts:2882-2978) serves BOTH finalize and recover pass-2.
Its `not-ahead` arm (:2889-2927) already does a branch-explicit push
(`pushDefaultToOrigin`) + a POST-push origin-containment recheck
(`gitIsAncestorOf(base, originDefaultRef(default))` at :2917-2926) → returns
`not-ahead` only on proven origin-containment, else the EXISTING
`push-unconfirmed` kind. But the `merged` arm (:2954-2977) runs a BARE push
(:2963) and returns `merged` with NO recheck. Fix: in the merged arm, replace
the bare `["push"]` with `pushDefaultToOrigin` (branch-explicit) and add the
SAME post-push origin recheck → return the EXISTING `push-unconfirmed` kind when
origin lacks the merge. Do NOT mint a new result kind — `push-unconfirmed` is
already wired as a retry-skip through finalize (:2629) and recover (:3290). The
teardown (:2705-2712, gated on local ancestry) is then reached only on proven
origin-containment. This one change fixes both finalize and recover pass-2.

EDGE-3 (silent non-ff degrade). The non-ff / origin-ahead degrade routes
through `retrySkip` (:2582-2587 → `console.error` + `retry:true`), which mints
NO operator-visible board row — the consumption seam (:2408-2416) mints a
sticky `DispatchFailed` only when `retry !== true`. Make it operator-visible by
routing non-ff through the sticky group (the pattern of `conflict` :2633-2637 /
`push-failed` :2638-2642 — return `{ok:false, reason}` WITHOUT `retry:true`),
keeping a `worktree-finalize-*` reason (NOT `worktree-recover-*`, so
`isWorktreeRecoverReason` :411-416 never auto-dismisses a genuine origin-ahead
block). An origin-ahead non-ff genuinely needs operator attention.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2882-2978 — mergeLaneBaseIntoDefault (not-ahead arm :2889-2927 = the recheck template; merged arm :2954-2977 = the bare push :2963 to fix)
- src/autopilot-worker.ts:2811-2858 — pushDefaultToOrigin (the branch-explicit push to reuse)
- src/autopilot-worker.ts:2604-2644 — finalize MergeLaneResult switch (push-unconfirmed already retry-skipped at :2629; conflict/push-failed sticky at :2633-2642), :2582-2587 retrySkip, :2408-2416 the sticky-vs-retry consumption seam, :2617-2620 non-ff's current retrySkip
- src/autopilot-worker.ts:411-416 (WORKTREE_RECOVER_REASON_PREFIX / isWorktreeRecoverReason); recover pass-2 :3119-3190 + pass-3 :3245-3295 (confirm the shared-routine fix flows to recover)

### Risks

- REUSE `push-unconfirmed` (already wired) — do not mint a new kind.
- The non-ff sticky MUST stay `worktree-finalize-*` (outside `worktree-recover`), else the level-triggered auto-clear silently dismisses an origin-ahead block.
- Test gotcha: test/autopilot-worker.test.ts:4909 asserts the BARE `push`; the branch-explicit fix breaks it + the :4954/:4992 fakes — the :5213-5257 push-unconfirmed test is the shape to copy.

### Test notes

Pure fake-runner (root tier — no real git): merged arm push exits 0 but origin
lacks the merge → `push-unconfirmed`, NO teardown; origin contains → `merged`,
teardown. non-ff → an operator-visible sticky DispatchFailed (assert via the
emitDispatchFailed spy, like :4542), reason `worktree-finalize-*`. Update the
:4909/:4954/:4992 fakes for the branch-explicit push + recheck.

## Acceptance

- [ ] the merged arm uses a branch-explicit push + post-push origin-containment recheck, returning push-unconfirmed when origin lacks the merge (no new result kind)
- [ ] teardown is reached only on proven origin-containment (both finalize + recover pass-2, via the shared routine)
- [ ] the non-ff / origin-ahead degrade mints an operator-visible row (no longer silent), reason worktree-finalize-* (outside the auto-clear prefix)
- [ ] no finalize-side reason satisfies isWorktreeRecoverReason
- [ ] the bare-push test assertions are updated for the branch-explicit push + recheck

## Done summary

## Evidence
