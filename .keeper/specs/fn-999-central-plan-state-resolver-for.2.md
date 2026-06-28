## Description

**Size:** M
**Files:** plugins/plan/src/verbs/{done,claim,reconcile,resolve_task}.ts, plugins/plan/src/runtime_status.ts, plugins/plan/test/*

### Approach

Replace the four bespoke per-verb repairs with the one resolver — the architectural
payoff (four scattered fixes collapse into one seam) and the fix for the
primary-outside-roots hole (two DIFFERENT bugs per the panel: `done` SILENTLY picks
the lane on empty roots via its cwd-then-global fallback (done.ts:82); claim/reconcile/
resolve-task HARD-ERROR TASK_NOT_FOUND (claim.ts:144, reconcile.ts:108, resolve_task.ts:75)
→ unusable in worktree mode when primary is outside roots).

- **done**: replace `resolveDoneProject` (done.ts:70) with `resolvePlanStateContext(taskId, project, format)`; overlay write via the returned ctx.stateDir.
- **claim**: replace `resolveProjectForTask`/findProjectsWithTask (claim.ts:117,143) with the resolver for STATE (overlay + brief write, claim.ts:182); keep `resolveWorkerRepos().targetRepo` for the worker's code cwd in the brief.
- **reconcile**: STATE/overlay read via the resolver (reconcile.ts:281); KEEP the source-commit scan over `targetRepo`+touched+primary (reconcile.ts:303-318) and the committed-state probe vs primary (already correct, reconcile.ts:299,330).
- **resolve-task**: STATE/status via the resolver; `targetRepo` stays the lane code seam (resolve_task.ts:112).
- **runtime_status.ts**: `resolveWorkerRepos` NARROWS to code routing — `targetRepo` stays; source the envelope's `primary_repo`/`state_repo` from the resolver (so reported == physical write site; today they match only by luck). Delete the now-dead bespoke wrappers (resolveDoneProject, resolveProjectForTask).
- Remove these four verbs from slice-1's source-guard exempt-list.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/verbs/done.ts:70,82,104; claim.ts:117,143,182,199; reconcile.ts:106,281,294-330; resolve_task.ts:48,73,112,118
- plugins/plan/src/runtime_status.ts:45-79 (resolveWorkerRepos/targetRepo/expectedWorkerCwd); invocation.ts:64 (state_repo sourced from primaryRepo)
- plugins/plan/test/saga-claim.test.ts, saga-reconcile.test.ts, worktree-done-state.test.ts (extend for primary-outside-roots)

### Risks

- The code-vs-state split must stay explicit: STATE → resolver (primary), CODE/commit-scan → targetRepo/cwd. Do not route the commit scan through primary.
- claim/reconcile/resolve-task currently hard-error on empty roots — the resolver must make them WORK when primary is outside roots (via def.primary_repo), not just stop picking the lane.
- Keep the brief/envelope `primary_repo`/`state_repo` sourced from the resolver so reported == physical.

### Test notes

Registry behavioral test (B): parametrize done/claim/reconcile/resolve-task — run each from a lane with NO --project; assert the mutation/read landed in primary/.keeper/state and lane/.keeper/state stays absent. Add the primary-outside-roots case for each (the previously-hard-erroring verbs now succeed against primary). Pure tier + the existing saga harnesses.

## Acceptance

- [ ] done/claim/reconcile/resolve-task route STATE through resolvePlanStateContext; bespoke wrappers deleted
- [ ] primary-outside-roots: all four resolve to primary (done no longer silently picks the lane; the other three no longer hard-error)
- [ ] code/commit routing stays on targetRepo/cwd; envelope primary_repo/state_repo sourced from the resolver
- [ ] registry behavioral test covers the four from a lane; pure tier green
- [ ] these verbs removed from the source-guard exempt-list

## Done summary

## Evidence
