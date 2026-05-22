## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/types.ts, src/plan-worker.ts, test/db.test.ts, test/reducer.test.ts, test/collections.test.ts, test/plan-worker.test.ts, test/integration.test.ts

The atomic two-table → embedded switch. Dropping the `tasks` table forces
the reducer write path, the descriptor/registry, the seed read, and the
types to all move together — this can't be partially landed without
breaking the build, so it is one task.

### Approach

1. **Schema v7** (`src/db.ts`): add `tasks TEXT NOT NULL DEFAULT '[]'` to
   `CREATE_EPICS`; delete `CREATE_TASKS` + `CREATE_PLANS_INDEXES`
   (`idx_tasks_epic`). Add a `// v6→v7:` migrate() step that is
   **version-guarded** (run only when stored `schema_version < 7`, since the
   backfill + DROP are not idempotent): `addColumnIfMissing(epics, tasks)` →
   backfill `UPDATE epics SET tasks = (SELECT json_group_array(json_object('task_id',task_id,'epic_id',epic_id,'task_number',task_number,'title',title,'target_repo',target_repo,'status',status)) FROM (SELECT * FROM tasks t WHERE t.epic_id = epics.epic_id ORDER BY task_number, task_id)) WHERE tasks IS NULL OR tasks = '[]'` (orphan/NULL-epic_id task rows are NOT embedded — dropped) → `DROP TABLE IF EXISTS tasks`. Bump `SCHEMA_VERSION` to 7. The backfill `ORDER BY (task_number, task_id)` MUST match the reducer's fold sort exactly.
2. **Reducer fold** (`src/reducer.ts` `projectPlanRow`): rewrite the
   `TaskSnapshot` branch to a read-modify-write on the parent epic
   (key off `snapshot.epic_id`, NOT `event.session_id` which is the task pk):
   `SELECT tasks FROM epics WHERE epic_id = ?`; parse (treat malformed/NULL as
   `[]` — never throw in-txn); replace-or-insert the element by `task_id`;
   re-sort `(task_number, task_id)`; if the epic row exists `UPDATE` it, else
   INSERT a **shell** (epic_id set, scalar columns NULL, `tasks=[the task]`);
   bump `last_event_id = event.id` / `updated_at = event.ts`. If
   `snapshot.epic_id` is null/absent → skip-and-log (orphan, cursor still
   advances). Rewrite the `EpicSnapshot` upsert so its `ON CONFLICT … DO
   UPDATE SET` lists only scalar columns and **never `tasks`** (INSERT
   defaults `tasks='[]'`), so a later epic snapshot can't clobber an array a
   shell already holds.
3. **Read surface** (`src/collections.ts`): add `"tasks"` to
   `EPICS_DESCRIPTOR.columns` AND `jsonColumns` (keep it OUT of `sortable` /
   `filters` — nested display array). Change `EPICS_DESCRIPTOR.defaultSort` to
   `{ column: "epic_number", dir: "asc" }` (`epic_number` is already in
   `sortable`). Delete `TASKS_DESCRIPTOR` + its `REGISTRY` entry. No
   `server-worker.ts` edit — confirm `runQuery` and `selectByIds` already
   `decodeRow`.
4. **Types** (`src/types.ts`): `Epic` gains `tasks: Task[]`; `Task` stays as
   the in-array element shape (no longer a standalone projection row).
5. **Seed** (`src/plan-worker.ts` `seedFromDb`): repoint the tasks half from
   `SELECT … FROM tasks` to enumerating each epic's decoded `tasks` array,
   reconstructing each `PlanTaskMessage` field-for-field to match
   `buildTaskMessage` (incl. `status ?? "open"` and `taskNumberFromId`), or
   the change-gate re-emits every plan-task on every boot.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:233-287 — `projectPlanRow`; TaskSnapshot branch becomes RMW, EpicSnapshot ON CONFLICT must drop `tasks`
- src/reducer.ts:200-213 — `extractPlanSnapshot`; `snapshot.epic_id` is the parent key
- src/reducer.ts:435-458 — `applyEvent`'s single BEGIN IMMEDIATE transaction the fold runs inside
- src/db.ts:394-461 — `migrate()` block + the :418 comment on version-guarding a non-idempotent backfill; `addColumnIfMissing` at :352; `SCHEMA_VERSION` at :27
- src/collections.ts:114-142 (EPICS_DESCRIPTOR), :152-193 (TASKS_DESCRIPTOR + REGISTRY entry to delete), :252-270 (decodeRow)
- src/plan-worker.ts:500-548 (seedFromDb), :399-413 (buildTaskMessage to match)

**Optional** (reference as needed):
- src/server-worker.ts:388-397 (runQuery decode), :736 (selectByIds decode) — confirm no edit needed
- test/db.test.ts:223-557 (migration test pattern), test/reducer.test.ts:733-943 (plan-fold tests + the :905 re-fold determinism guard)

### Risks

- The from-scratch re-fold determinism test (`test/reducer.test.ts:905`) is the headline guard — the deterministic `(task_number, task_id)` sort and the migration backfill ordering must agree with each other AND with the live fold. TaskSnapshot-before-EpicSnapshot ordering exercises the shell path on replay.
- `Object.keys(row).sort()` column-set assertions in collections tests break when `tasks` joins `EPICS_DESCRIPTOR.columns` — update them.
- Schema-version assertions hardcode `"6"` across test/db.test.ts — bump to `"7"`; flip the two `tasks`-table-exists assertions.

### Test notes

- Migration: build a v6 DB with `epics` + `tasks` rows (incl. an orphan NULL-epic_id task), reopen via `openDb`, assert `tasks` table gone, `epics.tasks` backfilled in `(task_number, task_id)` order, orphan dropped, `schema_version = "7"`.
- Reducer: rework `getTask` helper to read inside `epics.tasks`; add cases for task-before-epic shell insert, later EpicSnapshot not clobbering tasks, sort determinism, malformed-array-in-txn → `[]`, orphan skip-and-log; keep the re-fold determinism test green.
- Collections: delete `getCollection("tasks")` / `TASKS_DESCRIPTOR` assertions; add an `epics.tasks` decode assertion (seed an epic with a JSON tasks string, assert `runQuery` returns a real array); assert `defaultSort` is `epic_number asc`.
- Plan-worker: rebuild the `seedFromDb` tasks-seed test to seed via an epic row carrying a `tasks` array; assert no re-emit when byte-identical.
- Integration: rewrite the task-projection assertion (test/integration.test.ts:817-843) to read `epics.tasks`; extend the live-patch assertion (:893-912) to prove a TaskSnapshot arrives as a `patch` on the parent epic row.

## Acceptance

- [ ] `epics` query serves a decoded `tasks: Task[]`; `tasks` collection + table are gone; `server-worker.ts` unchanged
- [ ] TaskSnapshot folds into the parent epic array (deterministic sort, shell insert when epic absent, orphan skip-and-log, malformed→`[]` in-txn); EpicSnapshot never clobbers `tasks`
- [ ] v6→v7 migration is version-guarded, backfills in `(task_number, task_id)` order, drops the `tasks` table; `SCHEMA_VERSION = 7`
- [ ] default `epics` sort is `epic_number asc`
- [ ] `seedFromDb` reconstructs from `epics.tasks` matching `buildTaskMessage` (no re-emit on byte-identical restart)
- [ ] from-scratch re-fold reproduces byte-identical `epics` rows; full `bun test --isolate` green

## Done summary

## Evidence
