## Description

**Size:** S
**Files:** src/readiness.ts, test/readiness.test.ts, cli/board.ts

### Approach

The defect is in `applySingleTaskPerRootMutex` pass-1
(`src/readiness.ts:968-972`): a running close row claims
`effectiveRoot(null, epic.project_dir)` unconditionally via
`isLiveWorkOccupant`, but the close row's "running" verdict can be
inherited from a task-level worker in a different `target_repo`
(`evaluateCloseRow` predicates 5/6 pool `epic.jobs` AND every
`task.jobs`). The contributing task already claims its own correct root
in the same pass-1 loop, so the close-row `project_dir` claim is
redundant when same-root and harmful when cross-root.

Fix (shape b): gate the close-row pass-1 claim on whether the close row
is running because of an EPIC-LEVEL source. Add the claim only when at
least one of the THREE epic-level running sources is live:

- `anyJobLinkRunning(epic)` — predicate 3 planner-running (creator /
  refiner sessions; epic-scoped by construction — `JobLinkEntry.kind`
  is `creator | refiner`)
- `anyEmbeddedJobWorking(epic.jobs)` — predicate 5 epic-level (close-verb) job
- `anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)` —
  predicate 6 epic-level sub-agent (ignore staleness: a
  `sub-agent-stale` close row still legitimately occupies `project_dir`)

CRITICAL: all THREE must be in the OR. Omitting predicate 3 drops a live
planner's legitimate `project_dir` lock — a NEW bug. When all three are
false, the close row's running-ness is purely task-derived → do NOT
claim `project_dir`; the contributing task's own pass-1 claim
(`effectiveRoot(task.target_repo, project_dir)`) already locks the
correct root.

This requires threading `subRunningByJobId` into
`applySingleTaskPerRootMutex` (it already exists as a local in
`computeReadiness` ~`:358`; pass it at the call site ~`:435`). Reuse the
existing helpers — do NOT inline new scans (they carry the null-guards).
Leave `effectiveRoot` untouched (preserve the byte-for-byte mirror with
`cli/autopilot.ts:498-500`). No new `Verdict`/`RunningReason` variant, no
schema bump, no keeper-py whitelist touch — this is a pure client-side
pass. Preserve `Set<string>` insertion order (board-traversal order):
the change only conditionally SKIPS an existing `add`, adds no new
iteration.

Then revise the now-stale in-place JSDoc on `applySingleTaskPerRootMutex`
(~`:919-1015`, the pass-1 close-row claim description) and
`evaluateCloseRow` (~`:680`) to state the scoped-attribution rule, and the
`cli/board.ts` header sentence (~`:217-224`) "The close row uses the
epic's `project_dir` directly…" to reflect the scoped claim. Revise in
place; do not append.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:943-1011 — `applySingleTaskPerRootMutex`; pass-1 close claim 968-972 (defect site)
- src/readiness.ts:680-826 — `evaluateCloseRow`; running sources pred 3 (708), pred 5 (729-736), pred 6 (752-757)
- src/readiness.ts:870-875 — `isLiveWorkOccupant`
- src/readiness.ts:1134, 1143-1155, 1157, 1223-1236 — `anyJobLinkRunning` / `anyEmbeddedJobWorking` / `anyEmbeddedJobHasRunningSubagent` / `closeRowHasRunningSubagent`
- src/readiness.ts:1024-1032 — `effectiveRoot` (do NOT change; mirror invariant)
- src/readiness.ts:355-435 — `computeReadiness`: `subRunningByJobId` local (~358) + mutex call site (~435)
- test/readiness.test.ts:1019-1095, 1783-1814 — closest per-root + close-row mutex tests; :1586 / :1713 negative-control pattern

**Optional** (reference as needed):
- cli/autopilot.ts:489-514 — `effectiveRoot` mirror + close runs in `project_dir` (509)
- src/await-conditions.ts:153-162 — `workable()` consumer (`single-task-per-root` is workable-anyway)
- src/types.ts:128 — `JobLinkEntry.kind = creator | refiner` (confirms planner is epic-scoped)

### Risks

- Dropping predicate 3 from the OR silently regresses planner-running root locks — the #1 trap. The OR must include all three sources.
- Sub-agent path: fixing only `job-running` leaves the sub-agent variant of the exact fn-651 regression live. One epic-level OR gate covers both predicate 5 and predicate 6.
- Signature change to an exported function ripples to the test harness — update the mutex test call sites.
- Over-correction: must NOT open a slot for a same-root task (`target_repo == project_dir`). Safe because the task's own claim still fires; prove with a negative control.

### Test notes

Add to test/readiness.test.ts (drive `applySingleTaskPerRootMutex`
directly with hand-rolled `perTask`/`perCloseRow` maps — existing
pattern):
- Regression (job path): close row running solely from a task worker with `target_repo != project_dir` → a ready sibling-epic task on `project_dir` stays `ready`, NOT `single-task-per-root`.
- Regression (sub-agent path): same shape via a cross-`target_repo` task worker's running sub-agent.
- Negative control 1: close row running from an epic-level close-verb job → still claims `project_dir`.
- Negative control 2 (planner): close row `running:planner-running` → still claims `project_dir` (proves pred 3 retained).
- Negative control 3: close row running from a same-root task (`target_repo == project_dir` or null) → root stays locked via the task's own claim.
- Boundary: close row running from BOTH an epic-level source AND a cross-repo task worker → still claims `project_dir`.
Run: `bun test test/readiness.test.ts`

## Acceptance

- [ ] `applySingleTaskPerRootMutex` pass-1 close-row claim is gated on an epic-level running OR: `anyJobLinkRunning(epic) || anyEmbeddedJobWorking(epic.jobs) || anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)`
- [ ] `subRunningByJobId` is threaded into `applySingleTaskPerRootMutex` from `computeReadiness`
- [ ] A close row running ONLY from a cross-`target_repo` task worker (job OR sub-agent) no longer claims `epic.project_dir`; the fn-651 scenario (keeper-root sibling task stays `ready`) is covered by a regression test
- [ ] planner-running, epic-level close-verb job, and epic-level sub-agent close rows STILL claim `project_dir` (negative controls pass)
- [ ] `effectiveRoot` unchanged; no new `Verdict`/`BlockReason`/`RunningReason` variant; no schema bump; no keeper-py touch
- [ ] JSDoc on `applySingleTaskPerRootMutex` + `evaluateCloseRow` and the `cli/board.ts` close-row comment revised in place to the scoped rule
- [ ] `bun test test/readiness.test.ts` green

## Done summary
Gated applySingleTaskPerRootMutex pass-1 close-row claim on an epic-level running OR (anyJobLinkRunning || anyEmbeddedJobWorking(epic.jobs) || anyEmbeddedJobHasRunningSubagent(epic.jobs, subRunningByJobId)) — a close row running solely from a cross-target_repo task worker (job or sub-agent) no longer phantom-locks epic.project_dir. Threaded subRunningByJobId into the mutex from computeReadiness; revised JSDoc on the mutex, evaluateCloseRow, and the cli/board.ts header to reflect scoped attribution. Added 2 regressions (job + sub-agent paths) and 3 negative controls (epic-level close-verb job, planner-running, same-root task) plus a mixed-source boundary; bun test test/readiness.test.ts green (87 pass).
## Evidence
