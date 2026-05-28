## Description

**Size:** M
**Files:** src/db.ts, src/collections.ts, src/types.ts, test/db.test.ts (new or existing), test/reducer.test.ts (re-fold determinism cases)

### Approach

Bump `SCHEMA_VERSION` from 30 to 31. ALTER block in `migrate()`:

1. `ALTER TABLE events ADD COLUMN bash_mutation_kind TEXT` (sparse, NULL default) — via `addColumnIfMissing` (idempotent).
2. `ALTER TABLE events ADD COLUMN bash_mutation_targets TEXT` (sparse JSON array, NULL default) — same.
3. `ALTER TABLE jobs RENAME COLUMN git_orphan_count TO git_unattributed_to_live_count` (SQLite 3.25+; Bun ships modern SQLite — confirmed).
4. `ALTER TABLE jobs ADD COLUMN git_orphan_count INTEGER NOT NULL DEFAULT 0` (fresh column, new strict-mystery semantic).
5. `CREATE TABLE IF NOT EXISTS file_attributions (project_dir TEXT NOT NULL, session_id TEXT NOT NULL, file_path TEXT NOT NULL, last_mutation_at REAL NOT NULL, last_commit_at REAL, op TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('tool','bash','inferred')), last_event_id INTEGER, updated_at REAL NOT NULL DEFAULT 0, PRIMARY KEY (project_dir, session_id, file_path))`.
6. Add two indexes: `CREATE INDEX IF NOT EXISTS idx_file_attributions_file ON file_attributions(project_dir, file_path)` and `CREATE INDEX IF NOT EXISTS idx_file_attributions_session ON file_attributions(session_id)`.
7. Add `bash_mutation_kind` partial index: `CREATE INDEX IF NOT EXISTS idx_events_bash_mutation_kind ON events(bash_mutation_kind) WHERE bash_mutation_kind IS NOT NULL`.

Update the lockstep `CREATE_EVENTS` / `CREATE_JOBS` literals (db.ts:270–372 / :477–501) so a fresh-DB boot creates the same shape. Add `CREATE_FILE_ATTRIBUTIONS` literal. Widen the `JOBS_DESCRIPTOR` in `src/collections.ts:87-142` with the renamed + added columns; widen `EmbeddedJob` + `Job` types in `src/types.ts:460-558`. The `EmbeddedJob` mirror inside `epics.jobs` / `epics.tasks[].jobs` carries both new counts so re-fold rebuilds them.

**Version-guarded rewind** (mirrors v25→v26, v28→v29, v29→v30 precedents at db.ts:2329-2415): inside a `storedVersionV30` rewind block, `UPDATE reducer_state SET last_event_id = 0; DELETE FROM jobs; DELETE FROM epics; DELETE FROM git_status; DELETE FROM file_attributions;`. Full re-drain on next boot repopulates everything — required because the new strict-orphan `git_orphan_count` semantic, the renamed column, and the `file_attributions` table are all computed by the new reducer fold (task 6), not derivable in-place.

### Investigation targets

**Required:**
- src/db.ts:53-56 — `SCHEMA_VERSION` constant
- src/db.ts:270-372 — `CREATE_EVENTS` literal + index blocks pattern
- src/db.ts:477-501 — `CREATE_JOBS` literal
- src/db.ts:524-538 — `CREATE_GIT_STATUS` (no change here, but read for context)
- src/db.ts:651-670 — `addColumnIfMissing` helper signature
- src/db.ts:2210-2415 — `migrate()` body, especially the v25→v26 / v28→v29 / v29→v30 rewind blocks for backfill+rewind pattern
- src/collections.ts:87-142 — `JOBS_DESCRIPTOR` columns/jsonColumns
- src/types.ts:460-558 — `Job`, `EmbeddedJob` shapes
- test/reducer.test.ts re-fold determinism tests for existing schema bumps (search for `re-fold` or `DELETE FROM jobs`)

**Optional:**
- src/reducer.ts:1031-1066 — `retractGitStatus` (will be touched in task 6, but the `file_attributions` retract symmetry starts here as table design)

### Risks

- SQLite `RENAME COLUMN` requires 3.25+; Bun ships 3.46+. Add a defensive check in the migration: `SELECT sqlite_version()` and emit a clear error if <3.25 (extremely unlikely but cheap to guard).
- `addColumnIfMissing` after rename: the migration must re-run safely if interrupted. The rename + add sequence is idempotent because both are guarded — but on a fresh v31 DB, the rename target IS the literal column in `CREATE_JOBS`, and the addColumnIfMissing for the NEW `git_orphan_count` then finds it missing and adds it. Walk through both fresh and migrating paths in a test.
- The `file_attributions` table's primary key is `(project_dir, session_id, file_path)` — confirm cross-project worktrees with the same file path collide intentionally (different project_dir keys make them distinct rows).
- Re-fold determinism: every projection-driving fact must live in the immutable event log. `file_attributions` rows are computed by task 6's reducer fold from events — this task only creates the table, not its content.

### Test notes

Tests in test/db.test.ts (new or extend existing): fresh DB at v31 has expected schema; migrating from a hand-crafted v30 DB through `migrate()` produces same schema. Re-fold determinism: insert a sample event sequence into a v30 DB, migrate to v31, assert rewind cleared projections, then drain (after task 6 lands; this task's tests can use a stub reducer for the projection assertions).

## Acceptance

- [ ] `SCHEMA_VERSION = 31` in src/db.ts
- [ ] `events.bash_mutation_kind` + `events.bash_mutation_targets` columns exist on fresh + migrated DBs; partial index on `bash_mutation_kind` exists
- [ ] `jobs.git_unattributed_to_live_count` (renamed from old `git_orphan_count`) and new `jobs.git_orphan_count` (strict semantic) both exist with correct types and defaults
- [ ] `file_attributions` table exists with PK `(project_dir, session_id, file_path)` and indexes on `(project_dir, file_path)` and `(session_id)`
- [ ] Version-guarded rewind: stored version 30 triggers `last_event_id = 0` + DELETE of jobs/epics/git_status/file_attributions; re-running migrate() on an already-v31 DB skips the rewind
- [ ] `JOBS_DESCRIPTOR` (src/collections.ts), `Job` and `EmbeddedJob` types (src/types.ts) carry the renamed + added columns
- [ ] test/db.test.ts (or equivalent) covers fresh-DB shape, v30→v31 migration shape, rewind idempotence, and re-fold reproducibility

## Done summary

## Evidence
