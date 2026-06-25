## Description
**Size:** S
**Files:** plugins/plan/src/vcs.ts, plugins/plan/src/commit.ts

### Approach
The plan auto-commit (`realGitVcs.commit`, plugins/plan/src/vcs.ts:210-221) shells `git commit -F - --` against a caller-supplied cwd; the branch the `chore(plan): done fn-X.N` / epic-close commit lands on is entirely a function of that cwd. In worktree mode the worker/closer runs IN the lane, so `process.cwd()` IS the lane — yet the commit lands on main, so the cwd is being re-resolved to the main toplevel somewhere on the path (the `.keeper` / state_path resolution). Make the plan-state commit land on the lane worktree branch: resolve the commit cwd to the worktree the worker runs in (the lane), not the repo's main toplevel, and apply the same explicit-cwd + GIT_* env-strip discipline as task .1. Plan commits never push, so this is purely the commit cwd/branch. Preserve the per-verb auto-commit-its-own-scope discipline (plugins/plan/CLAUDE.md).

### Investigation targets
**Required:**
- plugins/plan/src/vcs.ts:141-152 (runGit), :210-221 (realGitVcs.commit) — the commit cwd/branch
- plugins/plan/src/vcs.ts:18-21 — the auto-commit call site / commit.ts threading repoRoot
- plugins/plan/src/state_path.ts — `.keeper` resolution; verify it does not force the main toplevel
**Optional:**
- src/worktree-git.ts — isLinkedWorktree for worktree-aware cwd resolution

### Risks
- Coordinated with task .3 (BUG 3): once plan-state done-commits land on the LANE, the main-worktree epics projection no longer sees status=done until the lane merges — task .3 must decouple the finalize trigger from the main projection. This task lands first so .3 designs against the corrected behavior.

### Test notes
- Plan tests run in-process via setVcs(fakeVcs) (plugins/plan/src/vcs.ts:441) — assert the commit cwd is the lane when running inside a worktree. Add a real-git slow plan test if the contract is genuinely git's execution.

## Acceptance
- [ ] plan-state commits (task done, epic close) made while running inside a lane worktree land on the lane branch, not main
- [ ] every plan git subprocess runs with explicit cwd + GIT_* env stripped
- [ ] in-process plan test asserts lane-cwd commit; the per-verb auto-commit-its-own-scope discipline is preserved
- [ ] bun run test:full green

## Done summary
Strip the four worktree-routing GIT_* vars (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR) from every plan git spawn in vcs.ts so the explicit cwd alone fixes the repo+branch; an inherited GIT_DIR no longer routes a lane-worktree done/close commit onto main. Added an in-process lane-cwd assertion and a real-git slow test proving env-strip isolation.
## Evidence
