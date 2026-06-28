## Description

**Size:** M
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

F3: a base merged into LOCAL default whose push then TIMED OUT (a transient,
no-teardown degrade — correct so far) is, next cycle, an ancestor of LOCAL
default. So BOTH `mergeLaneBaseIntoDefault`'s not-ahead short-circuit
(src/autopilot-worker.ts:2783) AND recover pass-3's is-ancestor gate (:3087)
treat it as already-merged and the base is torn down WITHOUT the merge ever
reaching origin → origin/<default> never advances, yet autopilot reports the
epic finalized.

THE FIX — never tear down a base whose merge is not on ORIGIN. Before tearing
down (or short-circuiting teardown for) a base that is an ancestor of LOCAL
default, verify origin/<default> contains it via a CACHED-ref
`gitIsAncestorOf` against `refs/remotes/origin/<default>` — the resolution
pattern in `remotePushFastForwardable` (src/worktree-git.ts:566-579:
`rev-parse --verify --quiet`, NO fetch). If origin lacks it, RE-PUSH local
default (a PUSH-ONLY path — no merge, so `mergeReadiness` is NOT needed; but
the fn-990 push gating IS: `remotePushTurnKey` FIRST, then the FF precheck
with `"unknown"` deferring — extract a shared push-default helper rather than
duplicate the gate ordering) and tear down ONLY after the push is confirmed.

This guard must cover BOTH seams: the :2783 short-circuit AND pass-3's
independent :3087 gate — pass-3 sweeps without calling
`mergeLaneBaseIntoDefault`, so it must run its own origin-containment check
before deleting. A never-pushed-default (unresolved origin ref →
`gitIsAncestorOf` false → "origin lacks base") routes through the same
turn-key path (admits a first push); on not-turn-key / push-timeout → DEFER
(transient retry-skip, no teardown), never delete. Failure reasons:
recover-side → `worktree-recover-*` (inside the auto-clear prefix, transient,
no sticky, no teardown); finalize-side → `worktree-finalize-*` with
`retry:true` (outside the prefix).

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2776-2835 — mergeLaneBaseIntoDefault (not-ahead :2783, push :2820, push-timeout :2828)
- src/autopilot-worker.ts:3078-3111 — pass-3 gate :3087 (the SECOND seam to guard before deleting)
- src/autopilot-worker.ts:2633-2702 — finalize teardown fall-through (the finalize-side seam)
- src/worktree-git.ts:554-581 — remotePushFastForwardable cached-ref resolution + the "unknown" tri-state to mirror
- src/commit-work/push.ts:156-197 — remotePushTurnKey (the first-push-admitting probe to reuse)

### Risks

- Pass-3 is the higher-impact seam (it sweeps without mergeLaneBaseIntoDefault) — guarding only :2783 leaves the bug live.
- Cached-ref read only (NO fetch) — respect the shared-checkout no-fetch/rebase/force invariant.
- The push-only helper must NOT run mergeReadiness (a push touches refs, not the tree) but MUST keep the turn-key+FF gating.

### Test notes

Pure fake-runner: a base that is an ancestor of LOCAL default but NOT of
origin/<default> → re-push ATTEMPTED, teardown only after the push is
confirmed; push-timeout / not-turn-key → DEFERRED, base NOT torn down,
recover-side reason `worktree-recover-*`; never-pushed-default (unresolved
origin ref) → first push admitted via turn-key.

## Acceptance

- [ ] a base merged to LOCAL default but not on origin is re-pushed before teardown — at BOTH the not-ahead short-circuit and pass-3's gate
- [ ] teardown happens only after origin/<default> provably contains the merge
- [ ] a never-pushed-default first push is admitted (turn-key path); not-turn-key / timeout DEFERS (no teardown)
- [ ] a re-push failure degrades to a transient retry-skip (recover→worktree-recover-*, finalize→worktree-finalize-* retry), never sticky, never teardown-on-failure
- [ ] the push-default path reuses the turn-key + FF gating and does NOT run mergeReadiness

## Done summary

## Evidence
