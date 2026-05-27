## Description

**Size:** M
**Files:** `src/readiness.ts`, `src/readiness-client.ts`, `scripts/autopilot.ts`, `test/readiness.test.ts`

### Approach

Widen `computeReadiness` in `src/readiness.ts:151` to accept a 4th optional
input `gitStatusByProjectDir: Map<string, { dirty_count: number; orphan_count: number }>`
(default `new Map()` so existing test callers keep their current
"predicate 6.5 doesn't fire" semantics). Thread it through to
`evaluateTask` and `evaluateCloseRow`.

In the task arm at `src/readiness.ts:305-314`, replace the
`pickFreshestEmbeddedJobByVerb(task.jobs, "work")` call with
`gitStatusByProjectDir.get(task.target_repo ?? epic.project_dir)` — the
same root-resolution shape `effectiveRoot` already uses for the per-root
mutex. In the close-row arm at `src/readiness.ts:447-457`, replace with
`gitStatusByProjectDir.get(epic.project_dir)` (no per-row override on the
close row). Keep the existing `worker_phase === "done"` /
`epic.status === "done"` outer gates untouched — only the source of the
counts changes. Delete `pickFreshestEmbeddedJobByVerb` at
`src/readiness.ts:746`.

In `src/readiness-client.ts:949-1017`, add a 4th subscription against the
`git_status` collection (already registered in `src/collections.ts:282`,
`GitStatus` type at `src/types.ts:769`). Build a
`Map<project_dir, {dirty_count, orphan_count}>` in `emitSnapshotIfReady`.
Widen the first-paint gate from three-strict to four-strict
(`epics.gotResult && jobs.gotResult && subagentInvocations.gotResult && gitStatus.gotResult`).
Pass the map into `computeReadiness` as the new arg.

Update `scripts/autopilot.ts:627` to pass `new Map()` explicitly — the
autopilot simulator builds a synthetic `Epic[]` and doesn't model real git
state, so the empty map preserves today's "simulator never blocks on git"
behavior. Add a one-line comment so a future reader doesn't "fix" it.

Add a regression test in `test/readiness.test.ts` (or wherever the
existing 6.5 cases live) asserting both arms: a task with a terminal
worker carrying `git_orphan_count = 2`, but a `gitStatusByProjectDir` map
whose entry for the epic's project_dir says `orphan_count = 0`, evaluates
to `{ tag: "ready" }` instead of `{ tag: "blocked", reason: { kind: "git-orphans" } }`.
Mirror for the close-row arm.

### Investigation targets

**Required** (read before coding):

- `src/readiness.ts:151` — current `computeReadiness` signature; widen here
- `src/readiness.ts:290-315` — task-path predicate 6.5
- `src/readiness.ts:438-457` — close-row-path predicate 6.5
- `src/readiness.ts:746` — `pickFreshestEmbeddedJobByVerb` to delete
- `src/readiness-client.ts:949-1017` — subscription wiring + first-paint gate
- `src/collections.ts:282` — `git_status` descriptor (confirm it's in the server's default subscribe filter, or opt-in only — 30-second check)
- `src/types.ts:769` — `GitStatus` interface
- `src/git-worker.ts:485` — `liveJobsForRoot` (why the per-job count freezes — context for the fix, no edit needed)
- `src/reducer.ts:999` — `projectGitStatus` UPDATE (only stamps live jobs — context, no edit needed)
- `scripts/autopilot.ts:627` — `computeReadiness` call-site needing the explicit empty-map arg

**Optional context:**

- alternative shape considered and rejected: fan `(dirty_count, orphan_count)` onto epic rows via a new `syncGitStatusIntoEpic` reducer path. Rejected because cross-repo tasks (`target_repo != epic.project_dir`) still need a per-root lookup, so the simpler "git_status map into readiness" path avoids two reducer paths converging on the same data.

## Acceptance

- [ ] `computeReadiness` accepts a 4th optional `gitStatusByProjectDir` arg, defaulting to `new Map()`
- [ ] `src/readiness.ts` task and close-row arms of 6.5 use the map lookup; `pickFreshestEmbeddedJobByVerb` is deleted
- [ ] `src/readiness-client.ts` subscribes to `git_status` and gates first-paint behind all four collections
- [ ] `scripts/autopilot.ts` passes `new Map()` with a rationale comment
- [ ] Regression test covers both arms (terminal worker with stale count, fresh git_status says 0 → `ready`)
- [ ] `bun test` and `bun run typecheck` pass

## Done summary

## Evidence
