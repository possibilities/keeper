## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts, cli/board.ts

### Approach

Narrow per-root occupancy so a `planner-running` verdict does not claim
the root, while leaving the per-EPIC mutex and the predicate-3 verdict
untouched (a planner still blocks its own epic).

1. Add `isRootOccupant(verdict)` next to `isLiveWorkOccupant`
   (`src/readiness.ts:896`): return `false` when
   `verdict.tag === "running" && verdict.reason.kind === "planner-running"`,
   else delegate to `isLiveWorkOccupant`. Real workers still occupy.
2. In `applySingleTaskPerRootMutex` (`src/readiness.ts:988`): swap the
   per-task pass-1 check at line 1007 (`!isLiveWorkOccupant` →
   `!isRootOccupant`) and the close-row pass-1 gate at line 1019
   (`isLiveWorkOccupant(closeVerdict)` → `isRootOccupant(closeVerdict)`),
   and drop the now-dead `anyJobLinkRunning(epic) ||` disjunct from
   `epicLevelRunning` (lines 1020-1023), keeping the
   `anyEmbeddedJobWorking` / `anyEmbeddedJobHasRunningSubagent` signals.
3. Do NOT touch `applySingleTaskPerEpicMutex` (it must keep
   `isLiveWorkOccupant`). Do NOT delete `anyJobLinkRunning` — it still
   backs predicate 3 at lines 495 and 734.

Key safety fact: `epics.job_links` carry only `kind: creator | refiner`
(planners); workers/closers live in `epic.jobs` / `task.jobs`. So
`anyJobLinkRunning(epic)` is a pure planner signal — dropping it from
`epicLevelRunning` leaves a valid 2-term disjunction covering real
workers, and the outer `isRootOccupant(closeVerdict)` guard already skips
a purely planner-derived close row.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:896-901 — `isLiveWorkOccupant`; the predicate `isRootOccupant` sits next to and delegates to.
- src/readiness.ts:988-1067 — `applySingleTaskPerRootMutex`; per-task check (1007), close-row gate (1019), `epicLevelRunning` disjunction (1020-1023).
- src/readiness.ts:223-227 — `RunningReason` union; `planner-running` is the kind to key on after narrowing `tag === "running"`.
- test/readiness.test.ts:1965-1999 — the test to FLIP ("planner-running close row STILL claims project_dir"): assertion becomes `{ tag: "ready" }`, name/comment invert.
- test/readiness.test.ts:1678-1746 — templates: 1678 "live-work blocked row claims the root" and 1713 "dep-on-task does NOT claim → sibling stays ready" (closest twin for the per-task analog to ADD).

**Optional** (reference as needed):
- src/readiness.ts:903-942 — `applySingleTaskPerEpicMutex` (DO NOT TOUCH; confirm it keeps `isLiveWorkOccupant`).
- src/readiness.ts:1190-1197 — `anyJobLinkRunning` (keep; still used at 495, 734).
- src/readiness.ts:60-92, 944-987, 883-895 — header predicate-12 prose + JSDocs to update.
- cli/board.ts:232-240 — stale doc-comment naming planner-running as a project_dir-locking source.

### Risks

- Concurrent planner + worker in the same working tree: git `index.lock`
  contention (latency, not correctness — git worker `busy_timeout` absorbs
  it) and dirty-file multi-attribution on the board mid-flight (expected /
  advisory, resolved after-the-fact by the mtime attribution pass). This
  is the deliberately-accepted tradeoff of the change.
- fn-661 reverse-depends on this behavior — call it out in the PR so the
  reconciler is designed knowing planner-running doesn't hold the root.

### Test notes

`bun test test/readiness.test.ts`. Flip the 1965 test; add a per-task
analog (planner-running task verdict in epic A does NOT demote a ready
sibling task in epic B on the same root — assert sibling stays
`{ tag: "ready" }`). Keep regression guards GREEN, do not weaken: 1678
(job-running task still claims), 1927 (epic-level close-verb job still
claims), 2001 (same-root task worker keeps root locked via own claim),
2045 (epic-level source + cross-repo boundary). Sanity-check
`test/await-conditions.test.ts` and `test/board.test.ts` still pass
(board planner-running refs are pill rollup, unaffected).

## Acceptance

- [ ] `isRootOccupant` added; returns false for `running` + `planner-running`, delegates otherwise.
- [ ] `applySingleTaskPerRootMutex` per-task (1007) and close-row (1019) checks use `isRootOccupant`; dead `anyJobLinkRunning ||` disjunct removed from `epicLevelRunning`.
- [ ] `applySingleTaskPerEpicMutex` unchanged; `anyJobLinkRunning` retained (predicate 3 still fires at 495/734).
- [ ] Header predicate-12 prose + `applySingleTaskPerRootMutex` JSDoc + `isLiveWorkOccupant` JSDoc + `cli/board.ts:232-240` doc-comment updated to state planners are root-exempt but epic-blocking.
- [ ] test/readiness.test.ts:1965 flipped to assert sibling stays `ready`; per-task analog added; `bun test test/readiness.test.ts` green.
- [ ] Consumer suites green: `bun test test/await-conditions.test.ts test/board.test.ts`.

## Done summary
Added isRootOccupant predicate that exempts planner-running verdicts from the per-root mutex while leaving the per-epic mutex on isLiveWorkOccupant; planners no longer demote sibling-epic ready tasks on the same root but still block their own epic. Flipped readiness.test.ts:1965 and added per-task analog; all 88 readiness tests and 104 consumer-suite tests green.
## Evidence
