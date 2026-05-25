## Description

Sourced from finding F1 (confirmed at `src/plan-worker.ts:1113`): `scanPlanctlDir`
iterates `for (const collection of ["epics", "tasks"])` and never visits
`state/tasks/`. At daemon boot, `runtimeStatusCache` is empty for every task id
whose state file exists on disk, so `buildTaskMessage` reads the cache as a miss
and emits `runtime_status: "todo"` regardless of the on-disk state. The bug is
silent — no error, no log — and self-heals only when the state file is next
written.

**Fix:** Before the existing `tasks/` loop in `scanPlanctlDir`, enumerate
`state/tasks/*.state.json` and prime `runtimeStatusCache` directly. Use the
same `coerceRuntimeStatus` guard used in the live `task-state` onChange arm so
the cache only holds valid four-value vocabulary entries. Priming before the
`tasks/` loop means the first `TaskSnapshot` emitted for each definition already
carries the correct `runtime_status` with no redundant re-emit needed.

**Test:** Add an integration test to `src/plan-worker.test.ts` that:
1. Writes `<planctlDir>/state/tasks/<id>.state.json` with `{"status":"in_progress"}`
   before constructing `PlanScanner`.
2. Writes the corresponding task definition file under `tasks/`.
3. Calls `scanPlanctlDir`.
4. Asserts the emitted `TaskSnapshot` carries `runtime_status: "in_progress"`, not `"todo"`.

This test mirrors the boot path exactly and would have caught the regression.

## Acceptance

- [ ] `scanPlanctlDir` enumerates `state/tasks/*.state.json` and primes
      `runtimeStatusCache` before scanning `tasks/`.
- [ ] Values are coerced through `coerceRuntimeStatus`; invalid entries are
      skipped (no cache write) — consistent with the live onChange arm.
- [ ] Integration test passes: pre-existing state file → correct `runtime_status`
      in emitted `TaskSnapshot`.
- [ ] All existing plan-worker tests pass (no regressions).

## Done summary
scanPlanctlDir now enumerates .planctl/state/tasks/*.state.json BEFORE the tasks/ loop and primes runtimeStatusCache via a new PlanScanner.primeRuntimeStatus(taskId, status) cache poke, using the same coerceRuntimeStatus guard as the live onChange arm (invalid values logged + skipped, no cache write). Added two integration tests in test/plan-worker.test.ts that mirror the boot path: pre-existing state file → first TaskSnapshot carries the correct runtime_status; invalid state value → task reads default todo. All 714 tests pass.
## Evidence
