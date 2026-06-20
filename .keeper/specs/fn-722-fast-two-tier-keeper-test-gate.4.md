## Description

**Size:** M
**Files:** test/git-worker.test.ts, test/commit-work.test.ts, test/commit-work-foundation.test.ts, test/find-task-commit.test.ts, test/git-wrapper.test.ts, test/plan-worker.test.ts, test/session-state.test.ts

### Approach

Adopt the shared `test/helpers/git-repo.ts` `initRepo(dir)` (from task 2) across the per-file divergent fixtures (`initRepo`/`makeRepo`/`gitInitPlanRoot`, all running the same init+config sequence today). Where a file's tests permit (no virgin/bare-repo requirement, no concurrent worktree mutation — safe since file-level `--parallel` runs a file's tests serially within one worker), move the one `git init` into `beforeAll` and reset between tests with `git reset --hard && git clean -fdx` (the `clean` is required — `reset` alone leaves untracked files and leaks dirty-count/orphan state). For files whose tests need a virgin or bare repo (some git-worker/plan-worker cases), keep fresh-per-test via the shared `initRepo`. Do NOT mock git — porcelain-v2 oid/mode + Session-Id/Job-Id/Task trailer parsing is the whole point. Preserve `realpathSync` wrapping where path-equality vs project_dir matters.

### Investigation targets

**Required** (read before coding):
- test/git-worker.test.ts:834 (initRepo), and the bare-remote / virgin-repo cases that can't share
- test/commit-work.test.ts:102 (initRepo), :113 (addBareOrigin); test/find-task-commit.test.ts:87 (makeRepo); test/git-wrapper.test.ts:37 (makeRepo); test/plan-worker.test.ts ~:1708; test/commit-work-foundation.test.ts ~:272; test/session-state.test.ts (initRepo)
- test/helpers/git-repo.ts — the shared initRepo from task 2

### Risks

- **Stale state leak across reset-reused repos:** missing `git clean -fdx` leaves untracked files → flaky dirty-count/orphan assertions. Default to fresh-per-test for any file where reset-reuse is non-obvious.
- **commit.gpgsign:** the shared initRepo must keep `commit.gpgsign false` or signed-by-default hosts hang.

### Test notes

Each touched file green; record spawn-count / wall-time reduction. `bun test test/git-worker.test.ts` is the biggest mover (~8.9s).

## Acceptance

- [ ] All seven files use the shared `initRepo`; no duplicated init+config sequences remain
- [ ] Reset-reused repos use `git reset --hard && git clean -fdx`; virgin/bare cases kept fresh
- [ ] Git never mocked; all touched files pass; spawn-count reduction recorded

## Done summary
Routed all seven real-git test fixtures (initRepo/makeRepo/gitInit/initRepoBare) through the shared test/helpers/git-repo.ts initRepo, eliminating every duplicated init+config sequence and adding the load-bearing commit.gpgsign false to the git-worker and git-wrapper fixtures that lacked it. Repos kept fresh-per-test (distinct seed-commit/bare-origin/virgin-HEAD state); git never mocked. All seven files green (146 + 138 tests pass).
## Evidence
