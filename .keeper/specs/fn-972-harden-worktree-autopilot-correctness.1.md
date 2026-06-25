## Description
**Size:** M
**Files:** cli/commit-work.ts, src/commit-work/push.ts, src/commit-work/git-exec.ts

### Approach
`keeper commit-work` resolves every git op (stage/commit/push, branch name, lock path) from a single `const cwd = process.cwd()` (cli/commit-work.ts:445). When two workers in two linked worktrees of the SAME repo commit concurrently, a sibling producer `pruneWorktrees`/`ensureWorktree` (NOT under the commit-work flock — src/autopilot-worker.ts:2103) can transiently perturb the lane's git-dir resolution, so the commit + push land on `main` instead of the lane branch (`inLinkedWorktree` at src/commit-work/push.ts:151-175 returns false). Harden the git resolution to be worktree-pinned and race-proof: (1) carry the resolved worktree path explicitly and pass `cwd: <worktreePath>` to every git spawn; (2) strip `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR` from the inherited env before each git spawn so no ancestor env overrides cwd discovery; (3) resolve the branch + linked-worktree verdict consistently via `git -C <worktree> rev-parse` at op time; (4) defense-in-depth: immediately before push, re-check HEAD and ABORT the push if it resolves to the default/protected branch from inside a linked worktree (never push lane work to main). Keep the existing shared flock.

### Investigation targets
**Required:**
- cli/commit-work.ts:445 — the single `process.cwd()` source for all git ops
- cli/commit-work.ts:204-218 — gitCommitStaged / pushCommitted re-shell rev-parse HEAD per call
- cli/commit-work.ts:517-519 — flock path from gitCommonDir(cwd); flock spans only stage->commit->push
- src/commit-work/push.ts:151-175 — inLinkedWorktree skip-push gate (the false-negative under race)
- src/autopilot-worker.ts:2103 — producer pruneWorktrees/ensureWorktree NOT under the commit-work flock (the racing writer)
**Optional:**
- src/commit-work/git-exec.ts:42 — GitRunner/gitExec seam
- src/worktree-git.ts — isLinkedWorktreePure, $GIT_DIR vs $GIT_COMMON_DIR

### Risks
- The race is intermittent; cwd-only may not close the window where a producer prune invalidates the worktree mid-sequence. Consider `git worktree lock` during the commit, or gating producer prune/ensure against a lane with a live worker. The Early proof point names this escalation.

### Test notes
- Fast tier: drive runForTest (cli/commit-work.ts:605) with an injected GitRunner asserting every spawn carries cwd=worktree and the push is skipped / aborts when HEAD is the default branch in a linked worktree.
- Add a real-git slow test (allowlist scripts/test-real-git-allowlist.txt) exercising concurrent commits from two linked worktrees of one repo, asserting each lands on its own lane branch and neither reaches main.

## Acceptance
- [ ] commit-work run inside a linked worktree commits ONLY to the worktree's checked-out lane branch, never to main
- [ ] commit-work never pushes from inside a linked worktree (push-skip is race-proof) and aborts loudly if a push would target the default/protected branch
- [ ] every git subprocess in commit-work runs with explicit cwd=worktree and GIT_* env stripped
- [ ] fast-tier test asserts cwd/branch/skip behavior; a real-git slow test covers concurrent same-repo lane commits (added to the allowlist)
- [ ] bun run test:full green

## Done summary

## Evidence
