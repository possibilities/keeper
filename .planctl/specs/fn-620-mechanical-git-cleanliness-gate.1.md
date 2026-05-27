## Description

**Size:** M
**Files:** src/db.ts, src/types.ts, src/reducer.ts, src/readiness.ts, test/reducer.test.ts, test/readiness.test.ts, CLAUDE.md

### Approach

Bump schema to v27 with two new int columns on `jobs` — `git_dirty_count INTEGER NOT NULL DEFAULT 0` and `git_orphan_count INTEGER NOT NULL DEFAULT 0` — via `addColumnIfMissing` (don't hand-roll ALTER) and keep `CREATE_JOBS` literal in lockstep. Multi-paragraph migration comment per the v24/v25 precedent style.

Update `Job` and `EmbeddedJob` interfaces in src/types.ts to carry both new fields (both `number`).

Extend `projectGitStatus` in src/reducer.ts so the same `BEGIN IMMEDIATE` that writes `git_status` also UPDATEs each job enumerated in `snapshot.jobs[]` — setting `git_dirty_count` to that job's `dirty.length` and `git_orphan_count` to the project-wide `snapshot.orphaned_files.length` (broadcast onto every job in that snapshot). After each UPDATE, call `syncJobIntoEpic` for that job so embedded `jobs[]` arrays on epics/tasks stay in sync. Inside `buildEmbeddedJob` (or whatever the embedded-shape builder reads), pick up the two new columns from the jobs row. Every existing caller of `syncJobIntoEpic` (Stop, SessionEnd, UserPromptSubmit, RateLimited, ApiError, InputRequest folds) naturally produces the new fields because they all RMW the same jobs row — the read side is the only change needed.

In `retractGitStatus` (GitRootDropped fold): pre-DELETE, read `git_status.jobs` JSON for the project being dropped to enumerate the attributed job_ids, then `UPDATE jobs SET git_dirty_count = 0, git_orphan_count = 0 WHERE job_id IN (...)`, then DELETE the git_status row. All inside the same transaction. Symmetric write/clear via the canonical attribution.

In src/readiness.ts, add two payload-less `BlockReason` kinds (`git-uncommitted`, `git-orphans`) to the discriminated union with JSDoc glosses. Add `formatReasonShort` arms returning the kind name verbatim.

Insert a new predicate between predicates 6 (sub-agent-running) and 7 (own-approval-pending) in BOTH `evaluateTask` (gated on `task.worker_phase === "done"`) and `evaluateCloseRow` (gated on `epic.status === "done"`). Pick the freshest worker job from the embedded `jobs[]` array — filter on `plan_verb === 'work'` for tasks, `plan_verb === 'close'` for the close row. The embedded array is already sorted `(created_at desc, job_id asc)` by `sortEmbeddedJobs` in the reducer, so "freshest" = first match in iteration order. Empty result (no work/close-verb job on this row) → skip the predicate and fall through to predicate 7. Otherwise: if `git_dirty_count > 0` → return `{ tag: "blocked", reason: { kind: "git-uncommitted" } }`; else if `git_orphan_count > 0` → return `{ tag: "blocked", reason: { kind: "git-orphans" } }`.

Update the predicate-ordering docstring at the top of src/readiness.ts (bump the count and insert the two new predicate entries). Update the `BlockReason` JSDoc block above the union with one-line glosses for the two new kinds.

Update CLAUDE.md's "Event-sourcing invariants" first bullet: weave the new GitSnapshot → jobs fan-out into the existing enumeration sentence as a fourth fan-out path alongside `syncJobIntoEpic` / `syncPlanctlLinks` / `syncJobLinksOnJobWrite`. Edit CLAUDE.md in place (symlinked to AGENTS.md).

### Investigation targets

**Required** (read before coding):
- src/db.ts:56 — `SCHEMA_VERSION = 26`, bump to 27
- src/db.ts:416-438 — `CREATE_JOBS` literal; keep in lockstep with ALTER defaults
- src/db.ts:575 — `addColumnIfMissing` helper (use, don't hand-roll)
- src/db.ts:1996-2123 — v24/v25 multi-paragraph migration comment style precedent
- src/db.ts:2125-2148 — v26 step template for v27
- src/reducer.ts:816-846 — `extractGitSnapshot` (payload already parsed; no new parser needed)
- src/reducer.ts:854-894 — `projectGitStatus` (fan-out lands here)
- src/reducer.ts:907-913 — `retractGitStatus` (GitRootDropped zero-out)
- src/reducer.ts:1551-1699 — `syncJobIntoEpic` / `buildEmbeddedJob` (read new columns)
- src/reducer.ts:1730-1754 — `syncIfPlanRef` (jobs-write fan-out convention)
- src/readiness.ts:12-58 — predicate-ordering module docstring (update)
- src/readiness.ts:66-97 — `BlockReason` JSDoc + discriminated union
- src/readiness.ts:210-323 — `evaluateTask` (insert between predicate 6 at ~263 and predicate 7 at ~280)
- src/readiness.ts:325-422 — `evaluateCloseRow` (insert between predicate 6 at ~379-386 and predicate 7 at ~394)
- src/readiness.ts:686-711 — `formatReasonShort` switch
- src/types.ts:302-394 — `Job` interface
- src/types.ts:466-506 — `EmbeddedJob` interface
- src/git-worker.ts:71-81 — `GitSnapshotPayload` (no payload changes needed)
- test/reducer.test.ts:160-211 — GitSnapshot test template ("folds into git_status and advances the cursor")
- test/readiness.test.ts:42-79 — `makeTask` / `makeEpic` builders
- test/readiness.test.ts:160+ — predicate-ordering matrix ("predicate X wins over Y" naming)
- CLAUDE.md — Event-sourcing invariants section, first bullet's fan-out enumeration sentence

**Optional** (reference as needed):
- scripts/board.ts:383-388 — `colorizePillsInLine` `blocked:*` warn-bucket fallback (auto-covers new pills, no change needed)
- scripts/autopilot.ts module header — edge-dispatch table covers only side-effecting edges (no update needed; the two new block reasons are inert for dispatch)

### Risks

- **`syncJobIntoEpic` blast radius.** Every existing caller (UserPromptSubmit, Stop, SessionEnd, RateLimited, ApiError, InputRequest folds, plus the new GitSnapshot fan-out) must produce the two new fields when RMW'ing the embedded array. Missing one means stale counts in `task.jobs[].git_*_count`. Mitigation: extend the `JobsRowForSync` interface (or whatever input `buildEmbeddedJob` reads) to require the new fields — TypeScript surfaces missing callers at compile time. Audit every callsite before declaring done.
- **`GitRootDropped` enumeration source-of-truth.** Use the pre-DELETE read of `git_status.jobs` JSON inside the same transaction as the DELETE. Cwd-matched enumeration is broader and would touch jobs that the fan-out never stamped; symmetric write/clear via the canonical attribution is cleaner and easier to test.
- **Re-fold determinism after migration.** `addColumnIfMissing` defaults all existing rows to 0; the next git-worker GitSnapshot tick (typically sub-second via `data_version` polling) reconciles. Window of "false-clean" between migration and first re-snapshot is acceptable per the brief's minimal-scope spirit (no `git_snapshot_at` column, no freshness predicate). The from-scratch re-fold replays every historical GitSnapshot event and re-derives the counts byte-identically.
- **Predicate-ordering test coverage gaps.** Without explicit tests for "5 wins over 6.5" and "6 wins over 6.5" and "6.5 wins over 7", a future predicate insert could silently reorder the pipeline. Add all three to the existing predicate-ordering matrix.

### Test notes

- **New reducer test** ("GitSnapshot fans out git counts into jobs and embedded arrays"): seed an epic + task + worker job, emit a GitSnapshot event whose `jobs[]` carries the worker's dirty[] and the project's orphaned_files[], drain, assert `jobs.git_dirty_count` and `jobs.git_orphan_count` reflect the snapshot AND that `epic.tasks[].jobs[]` embedded array carries them too. Assert cursor advances.
- **New reducer test** ("GitRootDropped zeroes jobs counts via canonical enumeration"): seed a project with a dirty job, emit GitRootDropped, assert that job's counts are 0 and that an unrelated job in another project is untouched.
- **New reducer re-fold test**: drain to current cursor, rewind cursor to 0, `DELETE FROM jobs`, redrain, byte-compare the row JSON. Counts must match.
- **New readiness tests** in the existing predicate-ordering matrix at test/readiness.test.ts:160+:
  - "predicate 6.5 git-uncommitted wins over predicate 7 own-approval-pending" (task path)
  - "predicate 6.5 git-orphans wins over predicate 7" (when dirty=0 but orphans>0)
  - "predicate 5 job-running wins over predicate 6.5" (worker still running)
  - "predicate 6 sub-agent-running wins over predicate 6.5"
  - "predicate 6.5 skipped when worker_phase !== 'done'" (task path)
  - "predicate 6.5 skipped when epic.status !== 'done'" (close-row path)
  - "predicate 6.5 skipped when embedded jobs[] has no work/close-verb entry"
  - "predicate 6.5 fires for evaluateCloseRow with plan_verb='close' filter"
- `formatPill` output test: `formatPill({tag: "blocked", reason: {kind: "git-uncommitted"}})` returns `"[blocked:git-uncommitted]"`; same for `git-orphans`.

## Acceptance

- [ ] Schema v27 lands with two new `INTEGER NOT NULL DEFAULT 0` columns on `jobs`; `CREATE_JOBS` literal kept in lockstep; v27 migration step carries multi-paragraph comment per v24/v25 precedent style
- [ ] `Job` and `EmbeddedJob` interfaces in src/types.ts carry both fields (both `number`)
- [ ] `projectGitStatus` fans out per-job `git_dirty_count` (from `snapshot.jobs[*].dirty.length`) + project-broadcast `git_orphan_count` (from `snapshot.orphaned_files.length`) to `jobs`; calls `syncJobIntoEpic` per touched job; all inside one `BEGIN IMMEDIATE` transaction
- [ ] `retractGitStatus` (GitRootDropped) zeroes both columns via the pre-DELETE `git_status.jobs` enumeration; unrelated projects untouched
- [ ] `buildEmbeddedJob` (and any RMW path) reads the two new columns from `jobs` so every embedded `jobs[]` propagation carries them
- [ ] New `BlockReason` kinds (`git-uncommitted`, `git-orphans`, payload-less) added to the union with JSDoc entries; `formatReasonShort` arms return the kind name verbatim
- [ ] New predicate inserted between predicates 6 and 7 in BOTH `evaluateTask` (gated `worker_phase === "done"`) AND `evaluateCloseRow` (gated `epic.status === "done"`); picks freshest worker job filtered by `plan_verb === 'work'` (task) / `'close'` (close row); empty selection → skips and falls through to 7; otherwise blocks on `git_dirty_count > 0` (returns `git-uncommitted`) else `git_orphan_count > 0` (returns `git-orphans`)
- [ ] Predicate-ordering tests pass: 6.5 wins over 7; 5 wins over 6.5; 6 wins over 6.5; gate skipped when not `worker_phase==="done"` / `epic.status==="done"`; gate skipped on empty filtered jobs; gate fires for both `evaluateTask` AND `evaluateCloseRow`
- [ ] Reducer fan-out test passes: GitSnapshot folds update `jobs` columns + embedded array; cursor advances; rewind-and-redrain reproduces byte-identical row JSON
- [ ] GitRootDropped zero-out test passes
- [ ] CLAUDE.md "Event-sourcing invariants" first bullet updated to enumerate the GitSnapshot → jobs fan-out as a fourth fan-out path
- [ ] src/readiness.ts module docstring predicate-count line + `BlockReason` JSDoc updated
- [ ] `bun test` passes; no regressions in existing readiness or reducer tests

## Done summary

## Evidence
