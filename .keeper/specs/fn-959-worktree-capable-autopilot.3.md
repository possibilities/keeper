## Description

**Size:** M
**Files:** src/worktree-git.ts (new), test/worktree-git-realgit.slow.test.ts (new), scripts/test-real-git-allowlist.txt

### Approach

The producer git driver consuming the topology plan: `git worktree add <path>
-b <branch> <commit-ish>`, `git worktree list --porcelain`, `git worktree
remove` (NEVER blind `--force`), `git worktree prune --expire now`. Merges are
SEQUENTIAL PAIRWISE `git merge` (never octopus), each guarded by `merge-base
--is-ancestor` (idempotent skip) and, on conflict, a `MERGE_HEAD`-guarded `git
merge --abort`. Resolve the default branch via `git symbolic-ref --short
refs/remotes/origin/HEAD` with a `main|master|trunk|develop` fallback (never
hardcode). Detect "in a linked worktree" by comparing `--git-dir` vs
`--git-common-dir` (`--path-format=absolute`) with a `--show-superproject-working-tree`
submodule guard. Every merge acquires the shared `$GIT_COMMON_DIR/keeper-commit-work.lock`
flock so it serializes against agent commits. All ops idempotent and re-entrant.

### Investigation targets

**Required** (read before coding):
- src/commit-work/flock.ts (CommitWorkLock.acquire/release; lock path from gitCommonDir) — reuse for merge serialization.
- cli/commit-work.ts:247-251 (gitCommonDir primitive), src/commit-work/push.ts:82-84 (getCurrentBranch via rev-parse).
- test/helpers/fake-git.ts (faked GitRunner seam), the existing *.slow.test.ts real-git tests (git-worker-realgit.slow.test.ts) + scripts/test-real-git-allowlist.txt.
- src/worktree-plan.ts (this epic, task .2) — the plan contract it consumes.

### Risks

- `git worktree prune` default expiry is 14 DAYS — automation MUST pass `--expire now` or stale entries linger and block gc.
- Branch already checked out in a stale worktree, or path already exists post-crash → prune/repair before re-add; never force-delete a `keeper/epic/*` branch blindly (ownership registry by naming convention).
- The driver is a PRODUCER (lives in the worker, shells git on an external tree) — never a fold, never writes keeper.db.

### Test notes

Real-git contract test in `*.slow.test.ts` (allowlisted): add/list/merge-clean/merge-conflict-abort/remove/prune on a temp repo. Pure logic (default-branch parse, linked-worktree detection) can also unit-test via fake-git in the fast tier.

## Acceptance

- [ ] Idempotent `worktree add/list/remove/prune --expire now`; remove never blind-forces a dirty tree.
- [ ] Sequential pairwise merge with `merge-base --is-ancestor` skip and `MERGE_HEAD`-guarded abort; octopus never used.
- [ ] Default-branch resolution via symbolic-ref + fallback chain; linked-worktree detection with submodule guard.
- [ ] Merges acquire the shared `$GIT_COMMON_DIR/keeper-commit-work.lock`.
- [ ] Real-git contract test is `*.slow.test.ts` and listed in the allowlist; fast-tier covers the pure helpers.

## Done summary

## Evidence
