## Description

**Size:** M
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts, plugins/plan/test/<new or extend worktree-lifecycle>.test.ts, keeper/CLAUDE.md, README.md

### Approach

Make finalize/recover degrade gracefully instead of sticky-jamming the close. (1) Add a clean-tree probe to src/worktree-git.ts (e.g. isWorktreeClean / treeStatus via `git status --porcelain` plus a detached-HEAD / wrong-branch / merge-in-progress check), returning a result-kind shape mirroring removeWorktree — it does NOT exist yet. (2) In finalizeEpic (autopilot-worker.ts:2494-2588) and recover pass-2 (:2729-2782), BEFORE the merge, if repoDir is dirty / off the default branch / mid-rebase, emit a DISTINCT skip-and-retry reason (e.g. worktree-finalize-dirty-checkout) and STOP that epic's finalize cleanly so it retries next cycle once the tree is clean. (3) Before the push, a non-fast-forward precheck via isAncestorOf(origin/<default>, <default>) — if the remote is ahead, the same distinct skip-and-retry (no fetch / rebase / force). (4) Make finalize idempotent: a re-run after a partial (post-merge / post-push) failure resumes teardown (is-ancestor detects already-merged; removeWorktree no-ops an already-gone worktree) instead of re-failing.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:2494-2588 finalizeEpic (order: branchExists -> doneState -> onDefault check -> merge -> push -> teardown -> delete base; add the prechecks + idempotency) + :2729-2782 recover pass-2 (same prechecks) + :2348-2364 the finalize call loop (it emits the sticky DispatchFailed keyed `close::<epic>`).
- src/worktree-git.ts:593-655 mergeBranchInto, :663-677 removeWorktree ({kind:"dirty"}), :362-408 hasMergeInProgress / abortInterruptedMerge / isAncestorOf, :244-279 resolveDefaultBranch / currentBranch, :300-308 deleteBranch — REUSE these, do not re-shell. Add the new clean-tree helper alongside them.
- **Auto-clear scoping (keeper/CLAUDE.md ~line 116 + autopilot-worker.ts ~:399 / ~:497):** the recover pass's level-triggered auto-clear of `close::<epic>` failures is scoped to `worktree-recover*` reason rows. The new dirty/non-ff skip reason is a FINALIZE-side reason — it MUST NOT be prefixed `worktree-recover*` (so it is never wrongly auto-dismissed), and it must be a clean skip-and-retry (so it is never a sticky jam). Keep both distinctions intact.

**Optional** (a stronger future alternative, NOT this task):
- A dedicated finalize worktree (merge+push in a throwaway worktree, never the human's checkout) eliminates the dirty-checkout case entirely but is a bigger change + adds another lane to manage. Note it in the epic, don't build it here.

### Risks

- Preserve the genuine-conflict-is-loud posture: a real divergent-lane CONTENT conflict still fails loud and is human-cleared (correct). This task ONLY converts the human's-WIP-blocks-the-merge case (and a non-ff push) into a clean skip-and-retry — never the divergent-content case.
- The new skip reason must stay OUTSIDE the `worktree-recover*` auto-clear scope, or a real recover conflict could be wrongly auto-dismissed (or the finalize skip wrongly stickied).

### Test notes

- Pure tier (root test/, fake runners — see the autopilot-worker.test.ts fakeRun patterns): dirty / off-branch / mid-rebase -> distinct skip-and-retry reason (not sticky); non-ff push -> distinct skip-and-retry; idempotent re-run after a simulated post-merge / post-push teardown failure -> completes.
- Real-git slow test (plugins/plan/test/): finalize into a dirty/occupied checkout -> skip-and-retry (not sticky); finalize re-run after a teardown failure -> idempotent completion.
- Update keeper/CLAUDE.md ~line 116 + the README finalize-degrade lines (forward-facing, rewrite in place). Default `bun test` stays pure; typecheck + lint green (root).

## Acceptance

- [ ] A clean-tree helper (git status --porcelain + branch/rebase checks) lives in worktree-git.ts with a result-kind shape.
- [ ] finalize + recover skip-and-retry on a dirty / off-branch / mid-rebase main checkout with a DISTINCT reason (not `worktree-recover*`-prefixed) — never a sticky un-clearable close; auto-clear scoping preserved.
- [ ] A non-fast-forward push -> distinct skip-and-retry (no fetch / rebase / force).
- [ ] finalize is idempotent: a re-run after a partial failure resumes teardown.
- [ ] Pure-tier + real-git slow tests cover all of the above; default `bun test` stays pure; keeper/CLAUDE.md:116 + README updated; typecheck + lint green.

## Done summary

## Evidence
