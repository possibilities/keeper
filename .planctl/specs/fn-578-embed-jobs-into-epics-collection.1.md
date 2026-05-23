## Description

**Size:** M
**Files:**
- `src/db.ts` (`CREATE_EPICS` literal, `addColumnIfMissing`,
  `SCHEMA_VERSION` 9 → 10, v9→v10 rewind-and-redrain block)
- `src/types.ts` (new `EmbeddedJob` interface; `Epic.jobs`,
  `Task.jobs` fields)
- `src/derivers.ts` (`parsePlanRef` sibling to fn-577's
  `planVerbRefFromSpawnName`)
- `src/reducer.ts` (`syncJobIntoEpic` helper; wire-in to five
  jobs-mutating sites + title-rule; preserve task element's
  `jobs` on TaskSnapshot RMW; extend EpicSnapshot ON CONFLICT
  carve-out)
- `src/collections.ts` (`EPICS_DESCRIPTOR.columns` +
  `jsonColumns` append `"jobs"`)
- `src/plan-worker.ts` (change-gate seed signature strips
  `epic.jobs` + `task.jobs`)
- `test/reducer.test.ts` (sync helper tests, re-fold
  determinism extension, shell-row tests, ON CONFLICT
  carve-out, TaskSnapshot preservation, boot-idempotency)
- `test/db.test.ts` (v9→v10 migration test)
- `test/collections.test.ts` (nested `task.jobs` decode)
- `test/derivers.test.ts` (or extend if fn-577 creates it) —
  `parsePlanRef` unit tests
- `README.md` (three in-place revisions)
- `CLAUDE.md` (DO NOT section revision)

### Approach

Mirror the v6→v7 `tasks` embedding precedent at
`src/db.ts:448-499` + `src/reducer.ts:301-418` exactly. Six pieces,
all landing in one PR / one `SCHEMA_VERSION` bump:

1. **Schema migration (`src/db.ts` ALTER slot, bump
   `SCHEMA_VERSION` 9 → 10):**
   - `addColumnIfMissing(epics, 'jobs', "TEXT NOT NULL
     DEFAULT '[]'")`. Update `CREATE_EPICS` literal at
     `src/db.ts:257-269` in lockstep.
   - **Version-guarded rewind-and-redrain block** (`if
     (storedVersion < 10)`):
     ```ts
     db.run("UPDATE reducer_state SET last_event_id = 0");
     db.run("DELETE FROM jobs");
     db.run("DELETE FROM epics");
     ```
     The existing boot drain runs immediately after `migrate()`
     returns; it rebuilds both projections from the event log
     using the new v10 reducer code. The reducer is the SINGLE
     source of truth — no migration-specific composition logic
     to drift. Idempotent: a second boot enters migrate with
     `storedVersion >= 10` and the rewind block doesn't fire.

2. **`parsePlanRef` added to `src/derivers.ts`:**
   - Regex `/^(fn-\d+-[a-z0-9-]+)(?:\.(\d+))?$/`. Captures epic
     slug + optional task ordinal.
   - Returns `{ kind: 'task', epic_id, task_id }` when ordinal
     present (`task_id = ${epic_id}.${ordinal}`), else
     `{ kind: 'epic', epic_id }`. Returns null on any shape
     mismatch — invalid `plan_ref` skips sync entirely.
   - Module-scope `const` regex so V8/JSC tier-up fires.
   - Sibling to fn-577's `planVerbRefFromSpawnName`; both parsers
     live in `src/derivers.ts`.

3. **`syncJobIntoEpic(db, jobsRow, eventId)` helper** in
   `src/reducer.ts` alongside `projectPlanRow`:
   - Guard: `jobsRow.plan_ref == null` → return (no-op).
   - `parsePlanRef(jobsRow.plan_ref)`. Null → return (skip;
     invalid producer data, never throw, cursor advances).
   - Build the `EmbeddedJob` element from `jobsRow`:
     `{ job_id, plan_verb, state, title, created_at, updated_at,
     last_event_id }`.
   - **For `kind: 'epic'`** (verbs `plan` / `close`):
     - `SELECT jobs FROM epics WHERE epic_id = ?` (guarded
       parse → `[]` on malformed, never throws — mirror
       `reducer.ts:373-381`).
     - Filter out existing entry by `job_id`, push new one,
       re-sort `(created_at desc, job_id asc)`. JSON.stringify.
     - Epic row exists: `UPDATE epics SET jobs = ?,
       last_event_id = ?, updated_at = ? WHERE epic_id = ?`.
     - Epic row absent: INSERT a shell row (epic_id set, scalar
       columns NULL, `jobs` carrying the one element). Mirror
       `reducer.ts:407-416` shape.
   - **For `kind: 'task'`** (verb `work`):
     - SELECT parent epic's `tasks` JSON array. Find the task
       element by `task_id`.
     - Task element exists: read its `jobs` array, filter-out by
       `job_id` + push + re-sort `(created_at desc, job_id asc)`,
       attach to a copy of the task element. Filter the OLD
       element out of `tasks` + push the NEW one + re-sort by
       existing `(task_number, task_id)` task sort.
     - Task element absent: create shell task element
       `{ task_id, epic_id, task_number: null, title: null,
       target_repo: null, status: null, depends_on: [],
       jobs: [<new entry>] }` and push.
     - Epic row absent: INSERT shell epic with `tasks` carrying
       the (possibly shelled) task element.
     - `UPDATE epics SET tasks = ?, last_event_id = ?,
       updated_at = ? WHERE epic_id = ?`.
   - **Always bump epic's `last_event_id` to the passed
     `eventId`** in the same UPDATE — fires the per-row diff.

4. **Wire-in to five jobs-mutating call sites + title-rule** (in
   `projectJobsRow`):
   - SessionStart `:545`, UserPromptSubmit `:583`, Stop `:599`,
     SessionEnd `:613`, Killed `:656`, title-rule `:700`.
   - AFTER each handler's UPDATE/INSERT actually wrote, `SELECT
     plan_ref, plan_verb, state, title, created_at, updated_at,
     last_event_id FROM jobs WHERE job_id = ?`.
   - If `plan_ref != null`, call `syncJobIntoEpic(db, row,
     event.id)`.
   - **The Killed-mismatch path** (which `break`s without
     writing) must NOT fire sync. Encode by reading-back only
     after a write actually happened (check the UPDATE's
     rows-affected, or hoist the sync into a single post-write
     hook that runs only when the handler reached the write).

5. **Existing fold preservation:**
   - **EpicSnapshot ON CONFLICT (`src/reducer.ts:316-325`)**:
     extend the existing `tasks` carve-out to also exclude `jobs`.
     Update the carve-out comment to reflect both column names.
   - **TaskSnapshot RMW (`src/reducer.ts:388-389`)**: when
     filtering by `task_id` and re-pushing the task element,
     read the OLD element's `jobs` array FIRST, then attach it
     to the NEW (snapshot-built) element before push. Plan-file
     snapshots carry zero job info — they must not clobber live
     state. Without this, every plan-file edit drops the
     job-association list.

6. **Read surface + plan-worker seed:**
   - `src/collections.ts:144-181` — append `"jobs"` to
     `EPICS_DESCRIPTOR.columns`. Append `"jobs"` to
     `EPICS_DESCRIPTOR.jsonColumns` so `decodeRow` parses
     top-level `epic.jobs`. Nested `task.jobs` rides through
     the existing `tasks` decode (`decodeRow` returns parsed
     arrays whose nested objects' nested arrays are already
     arrays — verify in test). Leave `jobs` OUT of `sortable` /
     `filters`.
   - `src/plan-worker.ts:770-823` — the change-gate seed
     reconstruction MUST strip `epic.jobs` from the
     epic-level fingerprint AND strip `task.jobs` from each
     task element's fingerprint before signing. Jobs are live
     state, not plan-file truth — including them re-emits
     every snapshot on every boot (worst-case feedback loop).

### Investigation targets

**Required** (read before coding):
- `src/db.ts:29` — `SCHEMA_VERSION` constant; bump 9 → 10.
- `src/db.ts:257-269` — `CREATE_EPICS` literal; add `jobs` column.
- `src/db.ts:341-376` — `addColumnIfMissing` helper.
- `src/db.ts:448-499` — v6→v7 ALTER + version-guarded backfill
  block (the precedent + the slot to append to).
- `src/reducer.ts:301-418` — `projectPlanRow` (closest precedent
  for `syncJobIntoEpic`'s read-modify-write shape, guarded parse,
  shell-row fallback, never-append discipline).
- `src/reducer.ts:316-325` — EpicSnapshot ON CONFLICT carve-out
  (the slot to extend for `jobs`).
- `src/reducer.ts:373-381` — guarded JSON.parse → `[]` on
  malformed, never throws (template for new code).
- `src/reducer.ts:388-389` — TaskSnapshot RMW filter+push (the
  slot to extend with OLD-element `jobs` preservation).
- `src/reducer.ts:407-416` — shell-row INSERT pattern.
- `src/reducer.ts:517-707` — `projectJobsRow`, the five
  jobs-mutating call sites + title-rule.
- `src/collections.ts:141-181` — `EPICS_DESCRIPTOR`.
- `src/collections.ts:252-270` — `decodeRow` (verify nested
  decode for `task.jobs` works without changes).
- `src/plan-worker.ts:770-823` — change-gate seed reconstruction.
- `src/types.ts:108-161` — `Epic` and `Task` interfaces.
- `src/derivers.ts` (exists after fn-577.1 lands) —
  `planVerbRefFromSpawnName`; sibling `parsePlanRef` lives here.
- `test/reducer.test.ts:1049-1500` — `epicSnapshotEvent`,
  `taskSnapshotEvent`, `getEpic`, `getTasks`, `getTask` helpers
  (mirror these for `getJobsForEpic`, `getJobsForTask`).
- `test/reducer.test.ts:1375-1422` — re-fold determinism test
  template; extend to cover new arrays.
- `test/db.test.ts:549-654` — v6→v7 migration test pattern;
  mirror for v9→v10.
- `test/collections.test.ts:127-190` — JSON-TEXT decode tests;
  add nested-decode case.

**Optional**:
- `src/seed-sweep.ts:188-242` — `jobs WHERE x IS NOT NULL`
  iteration precedent (informational; this work uses
  rewind-and-redrain, so doesn't need this iteration pattern
  directly).

### Risks

- **`fn-577` hard prereq, not yet landed.** fn-577 task .1 is
  `todo`. This work imports `parsePlanRef` (sibling) from
  `src/derivers.ts` which fn-577.1 creates. Coordinate landing
  order: fn-577 first, then this. `depends_on_epics:
  [fn-577-...]` declared in scaffold makes this explicit.
- **`fn-576` task .8 overlap.** fn-576's docs sweep edits
  `src/reducer.ts`, `src/collections.ts`, `README.md` — all
  touched here. Merge-conflict risk; Phase 7 wires the overlap.
- **Plan-worker seed signature drift.** If the seed reconstruction
  isn't updated to strip `epic.jobs` / `task.jobs`, every boot
  re-emits every snapshot — worst-case feedback loop (jobs fan
  into epics → snapshot re-emits → carve-out preserves the data
  but every epic patches anyway). The boot-idempotency test is
  the guard.
- **`SCHEMA_VERSION` collision with fn-577.** fn-577 bumps 8 → 9.
  This work bumps 9 → 10. If this lands first (it shouldn't,
  but if), rebase the version number — never both at 9.
- **Re-fold cost on migration.** Rewind-and-redrain re-folds the
  entire event log inside the migrate transaction. Bounded by
  events table size — seconds to tens of seconds on a developer
  machine with thousands of sessions. One-time cost; acceptable.
- **Task-level shell extends precedent one level deeper.**
  Existing precedent shells epic rows when TaskSnapshot arrives
  before EpicSnapshot. This work shells epic + task element when
  a work-verb job's SessionStart arrives before either. Verify
  via test (re-fold idempotency across all four arrival orderings).

### Test notes

- **`parsePlanRef` unit tests** in `test/derivers.test.ts`:
  epic-form (`fn-1-foo`), task-form (`fn-1-foo.2`), malformed
  (`fn-1-foo.`, `fn-1`, `fn--foo`, empty), uppercase reject,
  trailing whitespace reject.
- **`syncJobIntoEpic` derivation tests** in
  `test/reducer.test.ts`:
  - SessionStart with epic-level `plan_ref` → `epic.jobs`
    carries one entry, `epic.tasks` untouched.
  - SessionStart with task-level `plan_ref` → corresponding
    task element's `jobs` carries one entry; epic shell exists,
    task element shell inside it exists.
  - SessionEnd on a `plan_ref` job → embedded entry's `state`
    updates to `'ended'`; epic's `last_event_id` bumps.
  - TranscriptTitle on a `plan_ref` job whose title changes →
    embedded entry's `title` updates.
  - Killed-mismatch path (no jobs write happened) → no sync
    fires; epic untouched.
  - Invalid `plan_ref` shape → no sync, cursor advances, no throw.
- **Shell-row tests**: SessionStart with task-level `plan_ref`
  before any EpicSnapshot/TaskSnapshot — assert shell epic +
  shell task element + `task.jobs` populated. Subsequent
  EpicSnapshot for the same epic — assert `task.jobs` AND the
  new `epic.jobs` PRESERVED (ON CONFLICT carve-out works).
  Subsequent TaskSnapshot for the same task — assert `task.jobs`
  PRESERVED (RMW merge works).
- **Re-fold idempotency** extending
  `test/reducer.test.ts:1375-1422`: insert mixed events (epic
  snapshots, task snapshots, SessionStart with various
  plan_ref values, lifecycle events), drain → snapshot `epics`
  + `jobs` rows. Rewind cursor + `DELETE FROM jobs` +
  `DELETE FROM epics`, redrain. Assert byte-identical rows
  including new embedded arrays at both levels. Cover all four
  arrival orderings: epic-first, task-first, job-first,
  epic+task-then-job.
- **Boot-idempotency** (plan-worker seed signature): drain →
  start plan-worker → assert the change-gate emits no new
  synthetic events for any epic whose only "change" is
  jobs-driven `last_event_id` bumps. Critical guard against
  the worst-case feedback loop.
- **v9→v10 migration test** mirroring
  `test/db.test.ts:549-654`: hand-build v9-shape DB with
  stamped `schema_version='9'`; seed historical events
  (mix of SessionStart with various plan_ref values,
  EpicSnapshot, TaskSnapshot, lifecycle events); seed
  pre-migration `jobs` + `epics` rows reflecting v9 reducer's
  output (no `jobs` column on epics). Call `openDb` →
  triggers migrate → rewind-and-redrain rebuilds via v10
  reducer. Assert: (a) `epics.jobs` column present, (b)
  `schema_version` stamped `'10'`, (c) rebuilt arrays match
  what the v10 reducer produces from the same events, (d)
  second `openDb` is idempotent (rewind doesn't re-fire).
- **Collections decode test** in `test/collections.test.ts`:
  seed an epic row with raw JSON-TEXT `tasks` containing nested
  `jobs` arrays, call `runQuery` / `selectByIds`, assert
  `task.jobs` is decoded to a real array (nested decode rides
  on the top-level `tasks` parse).
- **Malformed-array safety**: seed `epics` row with garbage
  TEXT in `jobs` column, fire a SessionStart that targets
  that epic → assert fold treats it as `[]`, advances cursor,
  doesn't throw.

## Acceptance

- [ ] `epics.jobs TEXT NOT NULL DEFAULT '[]'` column added via
  `addColumnIfMissing`; `CREATE_EPICS` literal updated in
  lockstep.
- [ ] `SCHEMA_VERSION` bumped 9 → 10; stamped on migrate.
- [ ] v9→v10 uses rewind-and-redrain (set `last_event_id=0`,
  `DELETE FROM jobs`, `DELETE FROM epics`) inside the
  version-guarded block; idempotent on re-run.
- [ ] `parsePlanRef` exported from `src/derivers.ts`;
  handles epic-form, task-form, malformed input; returns null
  on shape mismatch.
- [ ] `syncJobIntoEpic` wired in to all five `projectJobsRow`
  write sites + the title-rule path; gated on `plan_ref != null`;
  never fires on Killed-mismatch (no-write) path.
- [ ] Shell-row pattern: SessionStart with `plan_ref` for an
  unsnapshotted epic/task creates shell rows carrying the
  new entry.
- [ ] EpicSnapshot ON CONFLICT `DO UPDATE SET` omits `jobs`.
- [ ] TaskSnapshot RMW preserves OLD task element's `jobs`
  when re-placing.
- [ ] Sort `(created_at desc, job_id asc)` applied on every
  write; never append.
- [ ] Malformed stored `jobs` blob → `[]` fallback, cursor
  advances, no throw.
- [ ] `EPICS_DESCRIPTOR.columns` and `jsonColumns` include
  `"jobs"`; nested `task.jobs` decodes via existing `tasks`
  parse without extra code.
- [ ] `Epic` and `Task` interfaces extended; `EmbeddedJob`
  exported.
- [ ] Plan-worker seed signature excludes `epic.jobs` AND
  `task.jobs`; boot-idempotency test passes.
- [ ] Test coverage: `parsePlanRef` unit, `syncJobIntoEpic`
  derivation, shell-row, re-fold idempotency including new
  arrays, boot-idempotency, v9→v10 migration, collections
  nested-decode, malformed-array safety.
- [ ] README revisions: in-place updates to Architecture,
  Non-goals, Inspect sections; no new sections appended.
- [ ] CLAUDE.md revision: in-place update to the DO NOT
  section's `epic.tasks`-only description.

## Done summary
Schema v11 embeds plan/close-verb jobs into epics.jobs and work-verb jobs into nested task.jobs sub-arrays via a syncJobIntoEpic reducer helper that fans every plan_ref-bearing jobs write into the right array inside the same BEGIN IMMEDIATE transaction. ON CONFLICT carve-out and TaskSnapshot RMW preserve embedded jobs across plan snapshots; plan-worker seed signature strips both jobs arrays to prevent the boot feedback loop.
## Evidence
