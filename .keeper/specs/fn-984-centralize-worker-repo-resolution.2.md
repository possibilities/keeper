## Description

**Size:** M
**Files:** plugins/plan/test/<new>-worktree-lifecycle.test.ts (slow tier), plugins/plan/package.json (only if test:slow needs adjustment), plugins/plan/CLAUDE.md (Running Things row only if needed)

### Approach

Add a real-git, opt-in slow-tier test in the PLAN plugin (NOT the root suite — keeps the root "one pure tier" invariant intact), gated by SLOW_ENABLED / KEEPER_PLAN_RUN_SLOW via `describe.skipIf(!SLOW_ENABLED)`. Reuse the src-commit.test.ts real-git tmp-repo harness. Drive the full lane cycle: create a temp repo (git init -b main, repo-scoped identity), provision a lane worktree, run `keeper plan claim` in the lane with KEEPER_PLAN_WORKTREE set (exercising the Task-1 seam), commit work to the lane branch, merge lane -> main, tear down (remove worktree + delete branch). Prefer importing the real producer helpers from src/worktree-git.ts (gitEnsureWorktree, gitMergeBranchInto, removeWorktree) + createWorktreeDriver with the default gitExec runner; if the cross-package import is blocked, fall back to the existing shelled-git harness pattern, still asserting the same invariants. CRITICALLY reproduce the polluted-GIT_*-env scenario (vcs.ts strips inherited GIT_* so a lane commit does not leak to main) — without it the test would not catch the original bug class.

### Investigation targets

**Required** (read before coding):
- plugins/plan/test/src-commit.test.ts:31-50 (real-git harness) and the "worktree-lane isolation" describe (~:531) — the reusable pattern + closest analogue (including the GIT_*-env pollution case at ~:528-531).
- plugins/plan/test/harness.ts:731 — SLOW_ENABLED / KEEPER_PLAN_RUN_SLOW; plugins/plan/package.json `test:slow` script.
- src/worktree-git.ts — gitEnsureWorktree:530, mergeBranchInto:593, removeWorktree:663, listWorktrees:337, resolveDefaultBranch:244.
- src/autopilot-worker.ts:2427 — createWorktreeDriver (injectable WorktreeGitRunner).

**Optional**:
- the Task-1 seam (claim-in-lane resolves through it).

### Risks

- Cross-package import: the plan plugin test importing root src/worktree-git.ts may hit tsconfig/package boundaries. Fallback: drive the cycle via the existing shelled-git harness (src-commit.test.ts already does real `git worktree add`/merge), asserting the same invariants.
- Leaked worktrees: `git worktree remove --force` before rm -rf; tolerant per-step cleanup in afterAll/finally (so a mid-cycle failure does not mask the assertion).
- Determinism: scope git identity/config to the temp repo; `git init -b main`; never mutate process.env GIT_* globally (use per-command env).

### Test notes

The default `bun test` MUST stay pure (no real git) — the new test is skipped unless KEEPER_PLAN_RUN_SLOW=1. Verify BOTH: `bun test` skips it (count shows skipped), and `bun run test:slow` runs and passes it. Read the lane's HEAD via `git rev-parse --abbrev-ref HEAD` (per-worktree HEAD), not a .git file read. Do NOT touch the root CLAUDE.md / README test-isolation prose.

## Acceptance

- [ ] A slow-tier test (KEEPER_PLAN_RUN_SLOW, describe.skipIf) drives provision -> claim-in-lane -> commit -> merge -> teardown on a real temp repo.
- [ ] Asserts the work commit lands on the LANE branch (not main), merges to main, and teardown removes the worktree + branch.
- [ ] Reproduces the polluted-GIT_*-env scenario so it would catch a lane-commit-leaks-to-main regression.
- [ ] Default `bun test` does NOT run it (stays pure); `bun run test:slow` runs and passes it. Root CLAUDE.md / README invariant untouched.

## Done summary
Added a real-git slow-tier worktree-lane lifecycle test (provision -> claim-in-lane -> commit -> merge -> teardown under polluted GIT_*), gated describe.skipIf(!SLOW_ENABLED) so the default bun test stays pure.
## Evidence
