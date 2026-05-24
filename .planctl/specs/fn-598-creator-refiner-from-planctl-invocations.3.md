## Description

**Size:** M
**Files:** src/db.ts, test/db.test.ts

### Approach

Bump `SCHEMA_VERSION` from 13 to 14. Add seven columns + one partial
composite index, then run a forward-UPDATE backfill that exercises the
deriver and the classifier ported in tasks .1 and .2.

Columns (in lockstep — both `CREATE_*` literal AND `addColumnIfMissing`):
- `events.planctl_op TEXT` (sparse, NULL on non-planctl rows)
- `events.planctl_target TEXT`
- `events.planctl_epic_id TEXT`
- `events.planctl_task_id TEXT`
- `events.planctl_subject_present INTEGER` (0/1 boolean, NULL means "deriver returned null")
- `jobs.epic_links TEXT NOT NULL DEFAULT '[]'` (JSON array)
- `epics.job_links TEXT NOT NULL DEFAULT '[]'` (JSON array)

Indexes (new `CREATE_V14_INDEXES` constant, mirrors `CREATE_V10_INDEXES` structure):
- `CREATE INDEX IF NOT EXISTS idx_events_planctl_session ON events (session_id, id) WHERE planctl_op IS NOT NULL`

Backfill (version-guarded — runs once on the v13→v14 transition, idempotent thereafter):
1. SELECT every `events` row where `hook_event = 'PreToolUse' AND tool_name = 'Bash' AND planctl_op IS NULL` (the WHERE picks up only un-backfilled rows; safe on partial-run resume).
2. For each row: parse `data` (try/catch → skip on malformed), invoke `extractPlanctlInvocation`, UPDATE the five `planctl_*` columns via `db.run` (uncached — bun:sqlite statement-cache pin per `src/db.ts:629-639`).
3. For each `session_id` with at least one `planctl_op != NULL` event after step 2: invoke `syncPlanctlLinks(db, sessionId, latestEventIdForSession, latestTsForSession)` from task .5 (re-derives `jobs.epic_links` + each touched `epics.job_links`).
4. Run `ANALYZE events;` once at the end of the v14 block so the query planner seeds stats for the new partial index from the first post-upgrade query.

Migration-test discipline: hand-stand-up a fresh DB at schema version 13,
insert legacy-shape PreToolUse:Bash rows with planctl commands in
`data.tool_input.command`, insert a `plan:plan` PreToolUse:Skill row,
reopen via `openDb`, assert (a) the five `planctl_*` columns are
backfilled, (b) `jobs.epic_links` + `epics.job_links` carry the right
classifier output, (c) re-running `migrate()` is a no-op (idempotent).

### Investigation targets

**Required** (read before coding):
- `src/db.ts:47` — `SCHEMA_VERSION` location.
- `src/db.ts:226-247` — `CREATE_EVENTS` literal.
- `src/db.ts:281-313` — `CREATE_JOBS` + `CREATE_EPICS` literals.
- `src/db.ts:275-279` — `CREATE_V10_INDEXES` (partial-index template).
- `src/db.ts:385-420` — `migrate()` function structure + `addColumnIfMissing` pattern.
- `src/db.ts:600-708` — the v9→v10 same-transaction backfill (THE template for this task's backfill).
- `src/db.ts:629-639` — bun:sqlite statement-cache pin comment block; explains why `db.run` (not `db.prepare`) is mandatory inside the ALTER's same-transaction backfill.
- `test/db.test.ts:390+` — closest migration test template (v9→v10 ALTER).
- `test/db.test.ts:321-326` — v11 rewind-and-redrain pattern (NEGATIVE example — this task uses forward UPDATE, not rewind).

**Optional**:
- `src/db.ts:736-749` — v11 cursor rewind (for reference only).
- https://www.sqlite.org/lang_analyze.html — `ANALYZE` semantics on first run.

### Risks

- Long backfill on a year-old DB: the per-session re-derive scans every session's events twice (once per planctl event for the events backfill loop, once per session for the projection re-derive). Mitigation: batch by session_id; document an estimated worst-case duration (probably seconds to minutes — within startup budget).
- bun:sqlite statement-cache pin violation: forgetting and using `db.prepare(…).run()` inside the ALTER's same-transaction loop breaks v10 precedent and produces SQLITE_BUSY or wedged migrations. Mitigation: the test asserts the migration runs to completion without prepared-statement reuse violations.
- Partial run resumes: keeper crashes mid-backfill, restarts, runs `migrate()` again. The WHERE `planctl_op IS NULL` predicate ensures only un-backfilled rows are touched. Re-derive of `jobs.epic_links` is idempotent (full-replace).

### Test notes

One migration test that walks the full v13→v14 transition: fresh DB at v13, insert ~5 PreToolUse:Bash rows with planctl commands + 1 PreToolUse:Skill plan:plan row, reopen via `openDb`, assert (a) the five planctl_* columns are populated, (b) jobs.epic_links holds the expected classifier output, (c) epics.job_links matches symmetrically, (d) schema_version is 14 post-migration, (e) re-running `migrate()` produces no further writes (idempotent). Mirror `test/db.test.ts:390+`.

## Acceptance

- [ ] `SCHEMA_VERSION` is 14; `CREATE_EVENTS` / `CREATE_JOBS` / `CREATE_EPICS` literals carry the new columns; `migrate()` has the matching `addColumnIfMissing` calls.
- [ ] `CREATE_V14_INDEXES` defines the partial composite index `(session_id, id) WHERE planctl_op IS NOT NULL`.
- [ ] `ANALYZE events;` runs at the end of the v13→v14 block.
- [ ] Migration test passes: stamps backfilled, projections re-derived, idempotent re-run.
- [ ] No `db.prepare(…)` inside the v14 backfill loop (uncached `db.run` only).

## Done summary

## Evidence
