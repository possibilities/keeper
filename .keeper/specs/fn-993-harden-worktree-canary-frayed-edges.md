## Overview

A GO panel cleared the worktree path for a supervised canary but named three
supervise-able edges. This closes them in code so the canary has none: the
finalize `merged` arm tears down without re-verifying the merge reached origin
(asymmetric with the `not-ahead` arm); the merge-path commit-work `flock` is an
unbounded blocking acquire that could freeze the reconcile worker thread; and the
origin-ahead / non-fast-forward degrade is silent (no operator-visible row).
End state: every teardown follows a merge provably on origin; no lock or local
git op can freeze the cycle (bounded → skip-retry); a non-ff skip surfaces a
visible board reason.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/commit-work-foundation.test.ts` — the merge/finalize + flock tiers

## Acceptance

- [ ] the finalize `merged` arm re-verifies origin-containment before teardown (no stranded-merge path)
- [ ] a merge-path lock acquisition that exceeds a deadline degrades to a skip-retry, never a freeze; default commit-work is unchanged
- [ ] the non-ff / origin-ahead degrade mints an operator-visible reason row, correctly prefixed
- [ ] no finalize-side reason satisfies isWorktreeRecoverReason

## Early proof point

Task that proves the approach: `.1` (reuse the existing `push-unconfirmed` kind for the merged-arm recheck). If it fails: the merged arm needs a distinct result kind rather than reusing push-unconfirmed.

## References

- A blind multi-model GO panel named these three as the only remaining supervise-able edges before the canary; a repo-scout verified the seams (the shared `mergeLaneBaseIntoDefault`, the existing `push-unconfirmed` kind, the `tryAcquire` LOCK_NB building block) and a practice-scout confirmed LOCK_NB + bounded poll is the only safe in-process flock bound. Builds on fn-990 / fn-991 / fn-992.
