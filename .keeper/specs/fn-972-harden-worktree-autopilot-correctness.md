## Overview
Worktree-mode autopilot forks each epic onto a git worktree lane and merges it to the default branch at close. An end-to-end run exposed four correctness bugs that let in-flight work escape onto main and left epics unfinalized. This epic hardens the commit-isolation, plan-state, finalize-trigger, and recovery paths so worktree-mode runs keep all work on lanes and close cleanly. Fixes land on main via NORMAL (non-worktree) autopilot — they must not run in worktree mode (they would hit the very bugs being fixed).

## Quick commands
- bun run test:full   # mandatory — touches daemon/worker/git process paths

## Acceptance
- [ ] commit-work + plan-state commits made inside a lane worktree land ONLY on the lane branch, never main/origin
- [ ] an epic whose closer completes finalizes (lane->default merge + push + teardown) without depending on the main-worktree projection seeing done first
- [ ] recover pass-1 never touches non-keeper `.claude/worktrees` lanes
- [ ] bun run test:full green; new real-git slow tests allowlisted

## Early proof point
Task that proves the approach: `.1` (commit-work lane isolation) — the core race. If it fails (cwd/env discipline alone cannot close the window): escalate to per-worktree locking or gating producer prune against live-worker lanes.

## References
- README ## Architecture worktree-mode block (~lines 3152-3186) — current-state prose; update on landing.
- fn-959 worktree-capable-autopilot — the landed feature these fixes harden.
- Reverse-dep advisory: fn-971.2 drops the reaper verdict gate; landing this epic first prevents stalled closers (BUG 3) from becoming a re-dispatch loop.

## Docs gaps
- **README.md ## Architecture worktree-mode block:** update the commit-work push-skip sentence, add plan-state lane-commit routing, verify the closer-reaches-done trigger description, add the recover pass-1 keeper-lane filter clause.

## Best practices
- **Explicit cwd per git spawn + strip GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR:** inherited env/cwd is the classic cause of worktree commits landing on the wrong branch.
- **Resolve branch from `git -C <worktree> rev-parse --abbrev-ref HEAD` at op time, never a cached string:** the per-worktree HEAD is authoritative.
- **Defense-in-depth: abort a push that would target the default/protected branch from a linked worktree.**
- **Classify keeper lanes by `keeper/epic/*` branch + `~/worktrees/<repo>--<slug>` path; never touch `.claude/worktrees/` lanes.**
