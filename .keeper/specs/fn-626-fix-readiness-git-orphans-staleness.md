## Overview

Predicate 6.5 in `src/readiness.ts` (the `git-uncommitted` / `git-orphans`
gate that blocks autopilot's `/plan:approve` dispatch) reads its counts off
the freshest embedded worker/closer job. Those counts only refresh while the
job is in `state IN ('working','stopped')` — once a worker goes terminal,
its `git_dirty_count` / `git_orphan_count` freeze at whatever the last live
snapshot recorded, while the project's actual git state may have moved on.
Witnessed: epic 623 task 1's worker (`state=ended`) carries
`git_orphan_count = 2`, while the `git_status` row for `/Users/mike/code/keeper`
correctly says `orphaned_count = 0` and the worktree is clean — the board
still renders `[blocked:git-orphans]` and autopilot won't dispatch.

Pivot the predicate to read the live, project-wide `git_status` row directly
by piping a `Map<project_dir, {dirty_count, orphan_count}>` into
`computeReadiness` as a 4th input and looking up by
`task.target_repo ?? epic.project_dir` (task arm) / `epic.project_dir`
(close-row arm). No schema bump — the per-job columns stay in place as a
historical record of what each job's last live tick saw, just no longer the
readiness source of truth.

## Acceptance

- [ ] `computeReadiness` accepts a 4th optional input
  `gitStatusByProjectDir`, defaulting to `new Map()`
- [ ] Task arm and close-row arm of predicate 6.5 read counts via the map
  lookup, not via `pickFreshestEmbeddedJobByVerb`
- [ ] `pickFreshestEmbeddedJobByVerb` is deleted (was 6.5's only consumer)
- [ ] `readiness-client.ts` subscribes to `git_status`, builds the map,
  gates first-paint behind all four collections, passes it to `computeReadiness`
- [ ] `scripts/autopilot.ts:627` passes an explicit `new Map()` with a
  comment noting the simulator's deliberate git-blindness
- [ ] New regression test covering: terminal worker with stale
  `git_orphan_count=2`, fresh `gitStatusByProjectDir` entry says
  `orphan_count=0` → verdict is `{ tag: "ready" }` (mirrored for close-row arm)
- [ ] `bun test` passes; `bun run typecheck` passes
