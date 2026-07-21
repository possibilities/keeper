## Description

Rework integrateRepoUnderLease (plugins/plan/src/verbs/close_finalize.ts:747)
so trunk integration happens in a private scratch worktree instead of the
shared checkout, per ADR 0102 (docs/adr/0102-private-worktree-trunk-integration.md):

- Cut a temporary worktree + temp branch from the local default tip under the
  existing trunk lease; merge the epic base (sourceOid) there; run the
  merge-suite gate against the merged tree in that worktree.
- Publish via a bounded fetch–merge–push retry of the temp branch onto the
  default branch (a racing origin is expected; a genuine origin-ahead non-ff
  after retries keeps the existing worktree-finalize-non-fast-forward sticky).
- The shared checkout is only ever fast-forwarded, and only when it is clean
  AND on the default branch (close_finalize.ts:787-797 branch check). A dirty
  or off-branch shared checkout DEFERS ONLY THE FF: integration itself
  completes, the epic lands, and the trailing shared checkout is left to the
  existing trailing-tip producers (shared-checkout-desync). Remove the
  any-dirt TRUNK_INTEGRATION_DIRTY refusal at close_finalize.ts:812-825; if a
  typed outcome is still needed for the deferred-ff case, mint a new visible,
  self-clearing code rather than reusing the refusal.
- Content conflicts in the scratch worktree keep the existing conflict
  outcome (the worktree-merge-conflict sticky path downstream); the temp
  worktree and branch are removed on EVERY exit path (success, conflict,
  gate-red, push-fail), never leaking worktrees.
- No MERGE_HEAD is ever visible in the shared checkout.
- Preserve lease acquisition/release semantics and all other typed outcomes
  of integrateRepoUnderLease/integrateEpicBases (close_finalize.ts:972).

Keep correctness tests deterministic and in-process per docs/testing.md:
drive the git-boundary decisions through the existing pure seams used by
plugins/plan/test/saga-close-finalize.test.ts; real-git coverage belongs to
the real-git suite's own gate if needed.

Files: plugins/plan/src/verbs/close_finalize.ts,
plugins/plan/test/saga-close-finalize.test.ts.

## Acceptance

- [ ] Integration completes with unrelated tracked and untracked dirt present
      in the shared checkout (test), landing the epic and deferring only the ff.
- [ ] A clean, on-branch shared checkout is fast-forwarded exactly as before.
- [ ] The any-dirt TRUNK_INTEGRATION_DIRTY refusal is gone; the deferred-ff
      path emits its typed, self-clearing signal.
- [ ] Temp worktree + branch are removed on success, conflict, gate-red, and
      push-fail paths (tests cover each exit).
- [ ] Conflict and non-ff outcomes preserve their existing typed codes.
- [ ] Suite gate runs against the MERGED tree in the scratch worktree.
- [ ] Existing saga-close-finalize tests stay green.

## Done summary

## Evidence
