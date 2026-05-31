## Overview

keeper's per-root concurrency mutex (`applySingleTaskPerRootMutex` in
`src/readiness.ts`) currently treats a running planner (`planner-running`
verdict — an epic whose `job_links` carry a `working` creator/refiner) as a
live occupant of the project root. That demotes a *sibling epic's* ready
task on the same root to `blocked:single-task-per-root`, starving real work
behind a planner that has no dispatched worker yet. This narrows root
occupancy so planners no longer claim the root — while STILL blocking their
own epic from dispatch (their tasks read `running:planner-running`, never
`ready`, and the per-EPIC mutex is left untouched). End state: a planner and
one real worker may run concurrently in the same working tree; a sibling
epic dispatches the moment its task is ready.

Repro: board frame pid 15011 frame 7 — epic 662 (planner `working` in
`/Users/mike/code/keeper`) demoted ready task 661.1 to
`blocked:single-task-per-root`.

## Quick commands

- `bun test test/readiness.test.ts` — readiness unit suite (drives the mutex helpers directly)
- `bun test test/await-conditions.test.ts test/board.test.ts` — consumer regression guards

## Acceptance

- [ ] A `planner-running` verdict no longer occupies the per-root mutex; a ready sibling-epic task on the same root stays `ready`.
- [ ] Real workers (`job-running`, `sub-agent-running`, `job-pending`) still occupy the root.
- [ ] A planner still blocks its OWN epic (per-epic mutex + predicate-3 verdict unchanged).
- [ ] `bun test test/readiness.test.ts` green; consumer suites green.

## Early proof point

Task that proves the approach: `.1` — flipping the existing
`test/readiness.test.ts:1965` assertion from `blocked:single-task-per-root`
to `ready`, plus a per-task analog, is the whole behavioral contract. If it
fails: the exemption predicate or the close-row gate is mis-scoped — re-read
the fn-655 `epicLevelRunning` disjunction.

## References

- `fn-661-server-side-autopilot-reconciler` (reverse-dep + file overlap) — its reconciler worker (task .3) and keeperd wiring (task .4) call `computeReadiness`, which calls this mutex. fn-661 must be designed/rebased knowing `planner-running` no longer holds the root mutex: a sibling task that previously read `blocked:single-task-per-root` now reads `ready` and is dispatchable concurrently with the planner. NOT wired as a hard dep (this change lands first; fn-661 consumes it).
- Schema fact making the change safe: `epics.job_links` entries are only `kind: creator | refiner` (planners). Workers/closers live in `epic.jobs` / `task.jobs`. So `anyJobLinkRunning(epic)` is a pure planner signal — safe to drop from the close-row `epicLevelRunning` disjunction.

## Docs gaps

- **`cli/board.ts:232-240`**: doc-comment naming planner-running as a `project_dir`-locking source is now stale — update to reflect planners are root-exempt.
- **`src/readiness.ts` header (lines ~60-92) + `applySingleTaskPerRootMutex` JSDoc (~944-987) + `isLiveWorkOccupant` JSDoc (~883-895)**: canonical predicate spec — must state planners are root-exempt but epic-blocking, and that per-root/per-epic now diverge on `planner-running`.
- **`README.md`** await.ts/autopilot.ts client descriptions: review-touch only — factually still correct; revise only if surrounding context grows a planner-exemption note.
