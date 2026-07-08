## Description

Two confirmed recovery-edge defects in `plugins/plan/src/verbs/done.ts`
(audited at commit 3d0e56da), both bundled here because they touch the same
verb's recovery paths and land as one commit.

Files: `plugins/plan/src/verbs/done.ts`,
`plugins/plan/test/saga-done-commit-atomic.test.ts`.

F1 (index not unstaged on unwind): `onCommitFailure` (done.ts:290-299)
restores the three state files' working-tree bytes via `atomicWriteRaw` /
`unlinkSync` but never unstages the git index. `commit.ts` `gitStage`
(`git add -- <files>`, l.103) runs before the pathspec `gitCommit`
(`git commit -F - -- <files>`, l.120) that git refuses mid-merge, so the
done-version bytes remain staged; a full-index merge-completion
(`git commit` / `git merge --continue`) then sweeps a durable half-stamp
into the commit and leaves HEAD/working-tree inconsistent. Fix: have
`onCommitFailure` also return the three paths' index entries to HEAD
(e.g. `git restore --staged --` / `git reset -q HEAD --` on the state repo)
alongside the working-tree restore.

F2 (heal blanks `## Evidence`): the heal branch preserves `## Done summary`
via `getTaskSection` (done.ts:210) but `evidenceText` is unconditionally
rebuilt from the empty-default `evidence`, so a self-heal without
`--evidence` blanks the spec's `## Evidence` section and overwrites the
runtime overlay's evidence — silent data loss. Fix: mirror the
summary-preservation, reading the existing `## Evidence` section on the
`healUncommittedDone` path when no `--evidence` is supplied.

## Acceptance

- [ ] `onCommitFailure` returns the three state paths' git index to HEAD, not only the working tree.
- [ ] A `healUncommittedDone` re-run without `--evidence` leaves `## Evidence` and the overlay evidence intact.
- [ ] Real-git (KEEPER_PLAN_RUN_SLOW) test asserts a clean index after a mid-merge `git commit -- <pathspec>` refusal (F1).
- [ ] Test asserts a heal re-run preserves the recorded `## Evidence` (F2).
- [ ] Test covers a heal whose own re-commit also fails mid-merge (the idempotent restore-to-already-done no-op).

## Done summary

## Evidence
