## Description

**Size:** M
**Files:** `src/plan-worker.ts`, `src/reducer.ts`, `src/db.ts`, `src/types.ts`, `src/daemon.ts`, `README.md`, `CLAUDE.md`, `test/plan-worker.test.ts`, `test/reducer.test.ts`, `test/fixtures/plan_classifier_cases.jsonl`

### Approach

Plan-worker ingests planctl's runtime task status (`todo|in_progress|done|blocked`) from `.planctl/state/tasks/<task_id>.state.json` files and folds it into the `epics.tasks` JSON array alongside a renamed `worker_phase` field (was `status`). The existing recursive `@parcel/watcher` on the repo root already sees the state subtree — extend `classifyPlanPath` at `plan-worker.ts:232-267` with a new 4-segment arm matching `.planctl/state/tasks/*.state.json`, returning a new classification like `"task-state"`. The boot-scan loop at `plan-worker.ts:771-826` adds a third subtree walk. A new `RawTaskState` interface and `coerceRuntimeStatus()` helper (mirror `coerceApproval` at `plan-worker.ts:354-368`) defensively parses the file. When either a task-file OR a state-file changes, the PlanScanner composes BOTH files' fields into one full `TaskSnapshot` event — the reducer fold stays wholesale per the existing "producer derives every field" pattern.

Rename the existing derived `status` field to `worker_phase` on `PlanTaskMessage` (`plan-worker.ts:139`), `RawTask` (`plan-worker.ts:310-319`), `buildTaskMessage` (`plan-worker.ts:744`), and the embedded `tasks` element in `reducer.ts:476-502`. Add `runtime_status` as a new sibling field on the embedded element with default `"todo"` when absent (matches planctl's `merge_task_state` convention).

Schema migration is a rewind-and-redrain on the `epics` table (template: `db.ts:862-873` v10→v11). Bump `SCHEMA_VERSION`; rewind cursor + `DELETE FROM epics` + re-drain; the reducer re-derives both new fields from the event log. Old pre-feature TaskSnapshot events safe-default `runtime_status` to `"todo"` via `data.runtime_status ?? "todo"` in the reducer.

Critical parity work: `seedFromDb` at `plan-worker.ts:841-949` reconstructs `PlanTaskMessage` from the persisted projection for the change-gate. The new fields MUST be added in IDENTICAL slot order between `buildTaskMessage`'s return and `seedFromDb`'s reconstruction — otherwise every task re-emits a synthetic `TaskSnapshot` every daemon boot (the #1 silent regression per repo-scout). Same lockstep applies to `syncJobIntoEpic` at `reducer.ts:528-531` — extend the OLD-element carve-out to preserve `worker_phase` + `runtime_status` alongside the existing `jobs` sub-array.

### Investigation targets

**Required** (read before coding):
- `src/plan-worker.ts:127-147` — `PlanTaskMessage` interface; split `status` → `worker_phase`, add `runtime_status`
- `src/plan-worker.ts:232-267` — `classifyPlanPath`; needs new arm for 4-segment `.planctl/state/tasks/*.state.json`
- `src/plan-worker.ts:354-368` — `coerceApproval` template for the new `coerceRuntimeStatus` helper
- `src/plan-worker.ts:339-344` — `APPROVAL_VALUES` `ReadonlySet` pattern for the new runtime-status enum set
- `src/plan-worker.ts:724-748` — `buildTaskMessage`; line 744 is the derived `status` literal to rename
- `src/plan-worker.ts:771-826` — `scanRoot` + `scanPlanctlDir`; needs `state/tasks/` walk
- `src/plan-worker.ts:841-949` — `seedFromDb` change-gate (slot-order parity is critical)
- `src/reducer.ts:316-352` — `PlanSnapshot` interface; add new fields to TaskSnapshot data blob
- `src/reducer.ts:400-567` — `projectPlanRow`; lines 476-502 are the embedded task element shape
- `src/reducer.ts:528-531` — `syncJobIntoEpic` OLD-element carve-out pattern (extend to new fields)
- `src/db.ts:862-873` — v10→v11 rewind-and-redrain template
- `src/db.ts:498-538` — `addColumnIfMissing`/`dropColumnIfPresent` idempotent ALTER primitives
- `src/daemon.ts:389-459` — `planWorker.onmessage` handler that builds the TaskSnapshot data blob

**Optional** (reference as needed):
- `/Users/mike/code/arthack/apps/planctl/planctl/store.py:151` — on-disk shape of `.planctl/state/tasks/*.state.json`
- `/Users/mike/code/arthack/apps/planctl/planctl/models.py:208-217` — `merge_task_state` default convention (`todo` when runtime is None)

### Risks

- **`seedFromDb` slot-order parity is the #1 silent regression risk.** Add a regression test that asserts the change-gate fingerprint is byte-stable across a boot — `buildTaskMessage(input)` and `seedFromDb`'s reconstruction must produce identical `JSON.stringify` output for every persisted task. Run it in CI.
- **`syncJobIntoEpic` carve-out lockstep**: extend the existing `jobs` sub-array carve-out at `reducer.ts:528-531` to ALSO preserve `worker_phase` and `runtime_status` from the prior task element. Otherwise every job tick stomps the task-status fields with stale snapshot values.
- **Re-fold determinism on the schema bump**: old TaskSnapshot events (pre-feature) have no `runtime_status` field. Reducer reads defensively (`data.runtime_status ?? "todo"`); test the from-scratch re-fold of an existing DB to confirm byte-identical embedded `tasks` arrays.

### Test notes

- Plan-worker tests in `test/plan-worker.test.ts`: new cases for `classifyPlanPath` 4-segment arm (positive: `.planctl/state/tasks/foo.state.json` → `"task-state"`; negatives: 3-segment matching, wrong middle dir, wrong extension).
- Fixture additions to `test/fixtures/plan_classifier_cases.jsonl` for the new arm.
- Reducer tests in `test/reducer.test.ts`: TaskSnapshot folds with and without `runtime_status` (defensive default); `syncJobIntoEpic` carve-out preserves `worker_phase` / `runtime_status` across a jobs-write fan-out.
- Boot-restart regression test: insert a task, drain, restart daemon (rebuild seed), assert NO new synthetic TaskSnapshot was emitted for the unchanged task. This catches slot-order parity bugs.

## Acceptance

- [ ] `classifyPlanPath` returns the new `"task-state"` classification for `.planctl/state/tasks/<id>.state.json` paths and `null` for malformed variants
- [ ] Boot scan walks `.planctl/state/tasks/` in addition to `.planctl/{epics,tasks}` without duplicating watcher subscriptions
- [ ] `PlanTaskMessage` carries `worker_phase` (was `status`) AND `runtime_status` fields; `buildTaskMessage` and `seedFromDb` produce byte-identical `JSON.stringify` output for every persisted task (regression test in CI)
- [ ] `epics.tasks[i]` embedded JSON contains both `worker_phase` and `runtime_status` after a TaskSnapshot fold
- [ ] `syncJobIntoEpic` carve-out preserves `worker_phase` and `runtime_status` from the prior task element when a job write fans out
- [ ] Schema bump in `db.ts` rewind-and-redrain re-derives both fields from the event log; from-scratch re-fold of a live DB snapshot produces byte-identical `epics.tasks` JSON
- [ ] Reducer defensively reads `data.runtime_status ?? "todo"` so old pre-feature TaskSnapshot events fold deterministically
- [ ] Malformed `.state.json` value safe-falls-through to `"todo"` with a stderr log (mirror `coerceApproval` pattern); fold never throws
- [ ] `README.md` inspect snippet (lines 440-442) lists `worker_phase` + `runtime_status` for tasks
- [ ] `CLAUDE.md` plan-worker invariant block has a one-sentence splice naming `.planctl/state/tasks/` as a watched subtree feeding TaskSnapshot

## Done summary

## Evidence
