## Description

Close the F1 coverage gap: the slow-tier `describe.skipIf(!SLOW_ENABLED)`
block in `plugins/plan/test/saga-done-commit-atomic.test.ts` proves
`realGitVcs.restoreIndexToHead(...)` works, but it reconstructs the unwind by
calling `autoCommitFromInvocation(...)` and the facade by hand — it never
drives `runDone`. The fast tier's `fakeVcs.restoreIndexToHead`
(`plugins/plan/test/fake-vcs.ts`) is a no-op, so a dropped or mis-pathed
`getVcs().restoreIndexToHead([taskPath, specPath, runtimeStatePath], ...)`
call in `plugins/plan/src/verbs/done.ts` `onCommitFailure` would pass every
test — the exact staged-half-stamp regression the fast tier cannot catch.

Add one slow-tier case that seeds a real mid-merge repo (MERGE_HEAD set),
runs the `done` verb end-to-end through the partial-commit refusal, and
asserts `git diff --cached` is empty afterward — proving the verb's own
wiring, not a hand-reconstruction, restores the index to HEAD.

Files: `plugins/plan/test/saga-done-commit-atomic.test.ts` (add the case;
reuse the existing real-git fixture setup).

## Acceptance

- [ ] A slow-tier case drives the `done` verb against a real mid-merge repo
      and asserts `git diff --cached` is empty after the unwind.
- [ ] The case fails if `onCommitFailure`'s `restoreIndexToHead` call is
      dropped or given wrong paths.
- [ ] `bun run test:full:slow` stays green.

## Done summary

## Evidence
