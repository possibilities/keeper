## Overview

Embed related jobs into the existing `epics` projection so a single
`epics` subscribe delivers the epic, its tasks, and the jobs related
to each — by role. Builds on
`fn-577-plumb-skill-and-slash-command-metadata` (HARD prereq), which
adds `jobs.plan_verb` ∈ {plan, work, close} and `jobs.plan_ref`
(epic-level or task-level). The new shape:

- `epic.jobs: EmbeddedJob[]` — entries where `plan_ref == epic_id`
  (verbs `plan`, `close`).
- `task.jobs: EmbeddedJob[]` on each element of `epic.tasks` —
  entries where `plan_ref == task_id` (verb `work`).
- `EmbeddedJob = { job_id, plan_verb, state, title, created_at,
  updated_at, last_event_id }` — minimal display projection.

One `syncJobIntoEpic` helper called from every reducer handler that
mutates a `jobs` row with non-null `plan_ref`. The pattern mirrors
the v6→v7 `tasks` embedding precedent 1:1 (sort, decode-at-boundary,
JSON-TEXT storage, ON CONFLICT carve-out, shell-row pattern). The
human explicitly accepted patch fan-out on every `plan_ref` job
tick — embedded shape is the chosen direction over the alternative
of a `plan_ref` filter key on `JOBS_DESCRIPTOR`.

## Quick commands

```sh
# Confirm the new column + nested array shape on a live DB:
sqlite3 ~/.local/state/keeper/keeper.db "
  SELECT epic_id, json_array_length(jobs) AS epic_jobs_n,
         json_array_length(tasks) AS tasks_n
  FROM epics WHERE jobs != '[]' LIMIT 5
"

# Unnest task-level work jobs for an epic:
sqlite3 ~/.local/state/keeper/keeper.db "
  SELECT e.epic_id, t.value->>'task_id' AS task_id,
         j.value->>'job_id' AS job_id, j.value->>'state' AS state
  FROM epics e, json_each(e.tasks) t, json_each(t.value->>'jobs') j
  WHERE e.epic_id = '<some-epic>'
"
```

## Acceptance

- [ ] `epics.jobs TEXT NOT NULL DEFAULT '[]'` column present;
  `CREATE_EPICS` literal + `addColumnIfMissing` in lockstep so fresh
  and migrated DBs converge to identical schema.
- [ ] `SCHEMA_VERSION` bumped 9 → 10; stamped on migrate.
- [ ] v9→v10 uses **rewind-and-redrain**: inside the version-guarded
  block, `UPDATE reducer_state SET last_event_id = 0`,
  `DELETE FROM jobs`, `DELETE FROM epics`. The existing boot drain
  runs after `migrate()` returns and rebuilds both projections
  using the new reducer code. Idempotent on re-run.
- [ ] `syncJobIntoEpic(db, jobsRow, eventId)` fires from all five
  jobs-mutating call sites (SessionStart, UserPromptSubmit, Stop,
  SessionEnd, Killed) AND the title-rule UPDATE, gated on
  `plan_ref != null`. Never fires on Killed-mismatch (no-write) path.
- [ ] Shell-row pattern: SessionStart with `plan_ref` whose parent
  epic/task isn't snapshotted yet creates shell epic row + shell
  task element (for task-level) carrying just the new entry.
  Subsequent EpicSnapshot / TaskSnapshot folds MUST NOT clobber the
  embedded `jobs`.
- [ ] EpicSnapshot ON CONFLICT `DO UPDATE SET` omits the new `jobs`
  column (mirroring the existing `tasks` omission at
  `src/reducer.ts:316-325`).
- [ ] TaskSnapshot RMW preserves the existing task element's `jobs`
  sub-array when re-placing by `task_id` (read OLD element's `jobs`
  into NEW element before push).
- [ ] Sort `(created_at desc, job_id asc)` applied on every write —
  never append. Total-order tiebreaker on `job_id` is non-negotiable
  for byte-identical re-fold.
- [ ] Malformed stored `jobs` blob → `[]` fallback inside the txn;
  cursor advances; no throw.
- [ ] `EPICS_DESCRIPTOR.columns` includes `"jobs"`;
  `EPICS_DESCRIPTOR.jsonColumns` includes `"jobs"`; nested
  `task.jobs` rides the existing `tasks` decode without separate
  pass (verified by test).
- [ ] `Epic` and `Task` TS interfaces extended in lockstep; new
  `EmbeddedJob` interface exported from `src/types.ts`.
- [ ] `parsePlanRef(ref): { kind: 'epic'|'task', epic_id, task_id?:
  string } | null` added to `src/derivers.ts` — one source of truth
  for splitting a `plan_ref`. Reused by `syncJobIntoEpic` AND any
  shell creation path.
- [ ] Plan-worker change-gate seed signature
  (`src/plan-worker.ts:770-823`) strips `epic.jobs` AND `task.jobs`
  from fingerprinting. Without this, every boot re-emits every
  snapshot.
- [ ] Re-fold determinism test (extends
  `test/reducer.test.ts:1375-1422`): rewind cursor + `DELETE FROM
  jobs` + `DELETE FROM epics` + redrain → byte-identical rows
  including the new arrays at both levels.
- [ ] Boot-idempotency test: drain → boot plan-worker → no new
  synthetic snapshot events emitted for epics whose only "change"
  is jobs-driven `last_event_id` bumps.
- [ ] v9→v10 migration test mirroring `test/db.test.ts:549-654`:
  hand-build v9-shape DB, seed historical events + jobs + epics,
  call `openDb`, assert `schema_version='10'`, assert rewind-and-redrain
  rebuilt arrays correctly, assert second `openDb` is idempotent.

## Early proof point

Task that proves the approach: `<epic_id>.1` (the sole task). If
the re-fold determinism test fails after wiring `syncJobIntoEpic`,
the bug is almost always in (1) the sort tiebreaker, (2) the
EpicSnapshot ON CONFLICT carve-out, or (3) the TaskSnapshot RMW
preservation — verify in that order before touching migration. If
the migration test fails on second-`openDb` idempotency, the
`storedVersion < 10` version guard is wrong.

## References

- v6→v7 `tasks` embedding precedent at `src/db.ts:448-499` (migration)
  and `src/reducer.ts:301-418` (`projectPlanRow` — closest match for
  `syncJobIntoEpic`'s read-modify-write shape).
- EpicSnapshot ON CONFLICT carve-out at `src/reducer.ts:310-326`.
- Shell-row pattern at `src/reducer.ts:407-416`.
- Re-fold determinism test pattern at `test/reducer.test.ts:1375-1422`.
- Migration test pattern at `test/db.test.ts:549-654`.
- `fn-577-plumb-skill-and-slash-command-metadata` — HARD PREREQUISITE.
  Adds `jobs.plan_verb` + `jobs.plan_ref` + `src/derivers.ts` with
  `planVerbRefFromSpawnName`. This work cannot land before fn-577.
- SQLite JSON1 §3.9 quirks (sqlite.org/json1.html) — why JS-side
  RMW, not `json_set`. Also §3.2.1 — why TEXT, not JSONB.

## Docs gaps

- **`/Users/mike/code/keeper/README.md`** — three in-place revisions:
  - Architecture section (lines 267-290) — plan-worker paragraph
    currently describes "each epic embedding its tasks as a JSON
    array." Revise in-place so the description reflects epics now
    also embed plan/close-level `jobs` and each task element embeds
    work-level `jobs`.
  - Non-goals list (lines 33-35) — same `epic.tasks`-only
    characterization needs in-place revision.
  - Inspect section (lines 295-315) — add or replace example
    demonstrating `json_each` over the new `jobs` arrays. Revise
    existing prose; don't append.
- **`/Users/mike/code/keeper/CLAUDE.md`** — DO NOT section's "each
  epic embeds its tasks as a JSON array — no peer `tasks` collection"
  sentence needs in-place revision once `jobs` is also embedded.
  Fold the sync-helper invariant into the existing "Cursor + projection
  advance in the SAME `BEGIN IMMEDIATE` transaction" bullet rather
  than adding a new top-level invariant.

## Best practices

- **JS-side RMW, never SQL `json_set`/`json_insert`** — SQLite's
  JSON minifier emits version-dependent bytes; SQL-side mutation
  breaks the byte-identical re-fold invariant. Mirror the
  `projectPlanRow` pattern (parse → mutate → re-sort → stringify).
  [sqlite.org/json1.html §3.9]
- **Total-order sort key with deterministic tiebreaker** —
  `(created_at desc, job_id asc)`. The trailing `job_id` is
  non-negotiable; two jobs with same `created_at` otherwise
  produce non-deterministic ordering across re-folds.
- **No JSONB BLOB storage** — JSONB is documented "intended for
  internal use by SQLite only." Stay TEXT.
  [sqlite.org/json1.html §3.2.1]
- **Validate `plan_ref` at the reducer boundary** —
  `parsePlanRef` returns null on shape mismatch; the sync helper
  treats null as "skip the fan-out, advance the cursor, no
  throw." Producer-side malformation can't wedge the reducer.
- **`db.prepare()` (uncached) inside `migrate()`** — Bun's statement
  cache (oven-sh/bun#1332) caches by SQL text. Statements prepared
  before an ALTER referencing new columns can produce subtle
  wrong-column-binding behavior. The existing migrate ordering
  handles this; don't add new pre-`migrate()` `db.query()` on
  `events` / `jobs` / `epics`.
