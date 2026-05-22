## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

Fold synthetic `EpicSnapshot` / `TaskSnapshot` events into the `epics` /
`tasks` projections, reusing the single `BEGIN IMMEDIATE` fold + cursor
transaction. This is the early proof point — it proves the
snapshot→synthetic-event→fold→projection path and re-fold determinism
before the watcher or read surface exist.

### Approach

Add `projectPlanRow(db, event)` beside `projectJobsRow`, dispatched from
`applyEvent`'s switch on a new `hook_event` value (`EpicSnapshot` /
`TaskSnapshot`). The entity id rides in `event.session_id` (the generic
entity key — the documented session_id overload); the full snapshot rides
in the `data` JSON blob. Add a guarded extractor mirroring
`extractSessionTitle`/`extractTranscriptPath` (try/catch `JSON.parse`,
skip-and-log on malformed, never throw — cursor still advances). Upsert
with `INSERT … ON CONFLICT(<pk>) DO UPDATE` so snapshots are idempotent
(last-write-wins). Set `last_event_id = event.id` on every fold — this is
the monotonic per-row `version` column the read-surface diff fires on
(jobs uses the same). Set `updated_at = event.ts`.

Field mapping from the snapshot blob: epic → `epic_number` (parsed from id
`fn-N-…` → N), `title`, `project_dir` (from `primary_repo`), `status`
(verbatim from the JSON `status` field). task → `task_number` (parsed from
id suffix `.M` → M), `title`, `epic_id` (from `epic`), `target_repo`,
`status` (DERIVED — no `status` field on disk; v1 rule: `worker_done_at`
present → `"done"`, else `"open"`). Parsing/derivation happens in the
producer (task 3) and arrives pre-computed in the blob; this task folds
whatever the blob carries. Keep the fold a pure function of the persisted
event so a from-scratch re-fold (rewind cursor, DELETE, re-drain) is
identical — `drain()` replays `events` in autoincrement-id order, NOT
FS-arrival order, so determinism holds.

### Investigation targets

**Required:**
- src/reducer.ts:311-325 — `applyEvent` (the BEGIN IMMEDIATE fold+cursor transaction); plan folds MUST use this, not a new path
- src/reducer.ts:174-261 — `projectJobsRow` switch + the SessionStart `INSERT … ON CONFLICT … DO UPDATE` upsert shape
- src/reducer.ts:106-163 — `extractSessionTitle`/`extractTranscriptPath` guarded-parse helpers (the model for the snapshot extractor)
- src/reducer.ts:134-136 — `titleSourceForEvent` (how `hook_event === "TranscriptTitle"` is special-cased; mirror for the two plan kinds)
- test/reducer.test.ts — the fold + re-fold-determinism + malformed-blob test patterns

**Optional:**
- src/collections.ts:40-46 — why `version` must be monotonic per row (diff fires on it)

### Risks

- `session_id` is `NOT NULL` — the entity id must always be present in the
  synthetic event (it is; producer guarantees it). Document the overload.
- Re-fold determinism is the load-bearing property: assert it with a test
  that drains, rewinds the cursor + `DELETE FROM epics/tasks`, re-drains,
  and compares rows byte-for-byte.

### Test notes

`test/reducer.test.ts`: hand-insert `EpicSnapshot`/`TaskSnapshot` rows
(via `stmts.insertEvent` with the blob) → `drain` → assert projection rows
+ monotonic `last_event_id`; a later snapshot for the same id upserts; a
malformed blob skips-and-logs but advances the cursor; the re-fold
determinism case above.

## Acceptance

- [ ] `projectPlanRow` folds `EpicSnapshot`/`TaskSnapshot` into `epics`/`tasks` inside `applyEvent`'s existing transaction
- [ ] Snapshots upsert idempotently by pk; `last_event_id` advances monotonically per fold
- [ ] A malformed `data` blob skips-and-logs and still advances the cursor
- [ ] From-scratch re-fold reproduces identical `epics`/`tasks` rows (test asserts)
- [ ] `projectJobsRow` / jobs folding is unchanged

## Done summary

## Evidence
